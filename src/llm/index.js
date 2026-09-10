/**
 * LLM analysis adapters. Input: call metadata + transcript + banned-word hits.
 * Output: structured AnalysisResult (see schema below).
 *
 * providers:
 *   anthropic       - Claude via the official SDK (default model claude-opus-5, structured output)
 *   custom_http     - any OpenAI-style chat/completions endpoint the customer brings (base_url + api_key + model)
 *   keywords_only   - no LLM; the analyzer relies on banned-word matching only
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config } from '../config.js';
import { getSettings } from '../db.js';
import { ProviderError } from '../resilience.js';

const cfg = () => config.llm;

export const AnalysisSchema = z.object({
  is_complaint: z.boolean().describe('هل العميل قدّم أو هدّد بتقديم شكوى رسمية، أو أبدى استياءً واضحاً من الشركة أو الموظف. كلمة "شكوى" أو "إزعاج" في سياق اعتذار أو نفي لا تُعدّ شكوى'),
  complaint_type: z.enum(['none', 'debt_dispute', 'call_frequency', 'service', 'employee_behavior', 'billing', 'delay', 'worker_issue', 'legal_threat', 'harassment', 'other']),
  needs_ticket: z.boolean().describe('هل تستدعي المكالمة فتح تذكرة جودة لتدخل الإدارة؟ نعم فقط إذا: ارتكب المحصل مخالفة، أو صرّح العميل بأنه قدّم أو سيقدّم شكوى رسمية لجهة رقابية أو قانونية أو لإدارة الشركة بسبب سلوك المحصلين أو الشركة، أو أبلغ عن مضايقة (اتصالات مفرطة، تواصل مع أهله أو عمله). اعتراض العميل على المديونية أو إنكارها أو طلب مهلة أو قوله "سأتقدم بشكوى" كردّ عاطفي عابر دون سلوك خاطئ من المحصل لا يستدعي تذكرة'),
  ticket_reason: z.string().describe('سبب فتح التذكرة في جملة واحدة، أو "لا يوجد" إن لم تكن مطلوبة'),
  agent_violation: z.boolean().describe('هل ارتكب الموظف (المحصل) مخالفة: تهديد غير مشروع بالترحيل أو الحبس أو الحجز أو القائمة السوداء، ادعاء كاذب (مثل "المكالمة مسجلة من هيئة الاتصالات" أو "تفويض من وزارة العدل")، إساءة أو تحقير، تهديد بالتواصل مع الأهل أو جهة العمل، أو سلوك غير مهني'),
  violation_type: z.enum(['none', 'illegal_threat', 'false_claim', 'insult', 'third_party_threat', 'unprofessional', 'other']),
  severity: z.enum(['low', 'medium', 'high']).describe('high = يستدعي تدخلاً فورياً (تهديد صريح، إساءة، شكوى رسمية)، medium = يحتاج مراجعة، low = لا مشكلة حقيقية'),
  summary: z.string().describe('ملخص المكالمة بالعربية في جملتين أو ثلاثة'),
  customer_sentiment: z.enum(['positive', 'neutral', 'negative']),
  quality_score: z.number().int().min(0).max(100).describe('تقييم جودة أداء الموظف في المكالمة من 0 إلى 100'),
  employee_mentioned: z.string().nullable().describe('اسم الموظف الذي اشتكى منه العميل إن ذُكر'),
  company_mentioned: z.string().nullable().describe('اسم الشركة أو الفرع الذي ذُكر إن وُجد'),
  issues: z.array(z.string()).describe('مشاكل محددة في أداء الموظف أو في الخدمة'),
  recommendations: z.array(z.string()).describe('توصيات مختصرة لتحسين الأداء'),
});

const SYSTEM_BASE = `أنت محلل جودة في مركز اتصالات شركة مهارة، والشركة تعمل في مجال تحصيل الديون: المحصل يتصل بعملاء عليهم مديونيات (فروع في مصر والسعودية).
ستستلم نص مكالمة مقسّماً إلى "المحصل" و"العميل" (بالعربية، لهجة مصرية أو سعودية، وقد يكون فيه أخطاء من التحويل الصوتي)، مع بيانات المكالمة وقائمة كلمات محظورة رصدها النظام آلياً.

مهمتك أن تحكم بالسياق، لا بمجرد وجود الكلمات:
1. شكوى العميل: تُعدّ شكوى فقط إذا اعترض العميل فعلاً أو هدّد بتصعيد (لجهة رقابية، محامٍ، إدارة) أو أبدى استياءً واضحاً. عبارات مثل "أسف على الإزعاج" أو "لو عندك شكوى تقدر تتواصل" من المحصل ليست شكوى. نفي العميل ("ما عندي شكوى") ليس شكوى.
2. مخالفة المحصل: يُسمح للمحصل بشرح الإجراءات القانونية المشروعة بأسلوب مهني وهادئ (مثل وجود مطالبة أو إمكانية اللجوء للجهات المختصة). لكن تُعدّ مخالفة: التهديد بالترحيل أو الحبس أو الحجز على الممتلكات أو منع السفر أو القائمة السوداء أو إيقاف الخدمات أو إلغاء الإقامة، الادعاء الكاذب بتفويض حكومي أو تسجيل من جهة رقابية، الإساءة أو التحقير أو رفع الصوت، التهديد بالتواصل مع الأهل أو الكفيل أو جهة العمل، أو السلوك غير المهني (مقاطعة، سخرية، "براحتك"، "مش شغلي").
3. قيّم أداء المحصل من 100: الأدب، الالتزام بالسياسة، وضوح المعلومات، إدارة المكالمة.
4. اذكر اسم الموظف أو الشركة إن ورد صراحة.
5. الخطورة: high إذا وُجدت مخالفة صريحة أو شكوى رسمية، medium إذا كان الموقف يحتاج مراجعة، low إذا لم توجد مشكلة حقيقية.
6. قرار التذكرة (needs_ticket): نحن في مجال التحصيل، فاعتراض العميل على المديونية أو إنكارها أو انزعاجه أو تهديده العابر بالشكوى أو المحكمة بخصوص الدين نفسه أمر يومي طبيعي ولا يستدعي تذكرة. افتح تذكرة فقط عندما: (أ) يرتكب المحصل مخالفة، أو (ب) يصرّح العميل صراحةً بأنه قدّم أو سيقدّم شكوى رسمية لجهة رقابية أو قانونية أو لإدارة الشركة بسبب سلوك المحصلين أو أسلوب الشركة، أو (ج) يبلّغ عن مضايقة حقيقية مثل اتصالات مفرطة أو تواصل مع أهله أو جهة عمله. عند الشك، لا تفتح تذكرة.
أجب بالعربية الفصحى المبسطة، موضوعياً ومختصراً.`;

/** System prompt = base rules + whatever the quality team wrote in settings (كلمات محظورة مسموح بها في سياق معيّن، سياسات خاصة...). */
function systemPrompt() {
  const extra = (getSettings().llm_custom_prompt || '').trim();
  return extra ? `${SYSTEM_BASE}\n\nتعليمات إضافية من إدارة الجودة (لها الأولوية عند التعارض):\n${extra}` : SYSTEM_BASE;
}

function userPrompt({ call, transcript, bannedHits }) {
  const hits = bannedHits?.length ? bannedHits.map((h) => `- "${h.word}" (${h.severity}) : «${h.context}»`).join('\n') : 'لا يوجد';
  return `بيانات المكالمة:
- السيرفر/الفرع: ${call.server_name}
- تحويلة الموظف: ${call.agent_ext || '-'} ${call.agent_name ? `(${call.agent_name})` : ''}
- رقم العميل: ${call.phone || call.dst_raw || '-'}
- التاريخ: ${call.calldate}
- مدة المكالمة: ${call.billsec} ثانية

كلمات محظورة رُصدت آلياً:
${hits}

نص المكالمة:
"""
${transcript}
"""`;
}

let _client = null, _clientKey = null;
function anthropicClient() {
  const c = cfg();
  const key = c.api_key || process.env.ANTHROPIC_API_KEY || '';
  // rebuild when the key is changed from the settings page (a cached client would keep using the old key)
  if (!_client || _clientKey !== key) {
    _client = new Anthropic({ ...(c.api_key ? { apiKey: c.api_key } : {}), timeout: 120000, maxRetries: 2 });
    _clientKey = key;
  }
  return _client;
}

const adapters = {
  async keywords_only() { return null; },

  async anthropic(input) {
    const c = cfg();
    const client = anthropicClient();
    const response = await client.messages.parse({
      model: c.model || 'claude-opus-5',
      max_tokens: 4000,
      system: [{ type: 'text', text: systemPrompt(), cache_control: { type: 'ephemeral' } }],
      output_config: { effort: c.effort || 'low', format: zodOutputFormat(AnalysisSchema) },
      messages: [{ role: 'user', content: userPrompt(input) }],
    });
    if (response.stop_reason === 'refusal') throw new Error(`LLM refused: ${response.stop_details?.explanation || 'policy'}`);
    if (!response.parsed_output) throw new Error('LLM returned no parseable output');
    return { ...response.parsed_output, provider: 'anthropic', model: response.model, raw: response.parsed_output };
  },

  async custom_http(input) {
    const c = cfg();
    if (!c.base_url) throw new Error('llm.base_url is not configured');
    const schemaHint = JSON.stringify({
      is_complaint: 'boolean', complaint_type: 'none|service|employee_behavior|billing|delay|worker_issue|legal_threat|harassment|other',
      agent_violation: 'boolean', violation_type: 'none|illegal_threat|false_claim|insult|third_party_threat|unprofessional|other',
      needs_ticket: 'boolean', ticket_reason: 'string',
      severity: 'low|medium|high', summary: 'string', customer_sentiment: 'positive|neutral|negative', quality_score: '0-100 integer',
      employee_mentioned: 'string|null', company_mentioned: 'string|null', issues: ['string'], recommendations: ['string'],
    });
    const res = await fetch(`${c.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.api_key}` },
      body: JSON.stringify({
        model: c.model, temperature: c.temperature ?? 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `${systemPrompt()}\n\nأجب بكائن JSON فقط بهذا الشكل بالضبط: ${schemaHint}` },
          { role: 'user', content: userPrompt(input) },
        ],
      }),
    });
    const raw = await res.text();
    if (!res.ok) { const err = new Error(`LLM ${res.status}: ${raw.slice(0, 400)}`); err.status = res.status; throw err; }
    const j = JSON.parse(raw);
    const text = j.choices?.[0]?.message?.content || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('LLM returned no JSON');
    const parsed = AnalysisSchema.parse(JSON.parse(m[0]));
    return { ...parsed, provider: 'custom_http', model: c.model, raw: j };
  },
};

export function llmReady() {
  const c = cfg();
  if (!c.provider || c.provider === 'keywords_only' || c.provider === 'none') return false;
  if (c.provider === 'anthropic') return !!(c.api_key || process.env.ANTHROPIC_API_KEY);
  return !!(c.base_url && c.api_key);
}

export async function analyzeWithLLM(input) {
  const p = cfg().provider || 'keywords_only';
  const fn = adapters[p];
  if (!fn) throw new Error(`unknown LLM provider "${p}"`);
  const t = Date.now();
  let out;
  try { out = await fn(input); } catch (e) { throw toProviderError(e); }
  if (out) out.took_ms = Date.now() - t;
  return out;
}

/**
 * Map SDK / HTTP failures to ProviderError so the AI lane pauses as a whole (and resumes by itself) instead of
 * failing calls one by one. Anything else (refusal, unparseable output) stays a call-level error.
 */
function toProviderError(e) {
  if (!e || e.name === 'ProviderError') return e;
  const status = Number(e.status) || 0;
  const msg = String(e.message || e).slice(0, 400);
  // the SDK keeps the API's own message in e.error.error.message; include causes (DNS / refused / TLS) for connection errors
  const all = `${e?.error?.error?.message || ''} ${msg}`;
  const cause = `${e?.cause?.code || ''} ${e?.cause?.message || ''} ${e?.cause?.cause?.code || ''}`;
  if (status === 402 || /credit balance|billing|insufficient[_ ](credit|fund|balance)|exceeded your current quota|usage limits?|spend(ing)? limit|regain access/i.test(all)) return new ProviderError('llm', 'billing', msg);
  if (status === 401 || status === 403 || /invalid x-api-key|authentication_error|permission_error/i.test(all)) return new ProviderError('llm', 'auth', msg);
  if (status === 404 && /model/i.test(all)) return new ProviderError('llm', 'config', msg);   // wrong model name
  if (status === 400 && /model|output_config|effort|thinking|not supported|unsupported|extra inputs|unknown (field|parameter)|max_tokens/i.test(all)) return new ProviderError('llm', 'config', msg);
  if (status === 429) return new ProviderError('llm', 'rate_limit', msg);
  if (status === 529 || (status >= 500 && status < 600) || /overloaded/i.test(all)) return new ProviderError('llm', 'provider_down', msg);
  // AnthropicError does not set .name, so detect connection failures by class and by text ("Connection error.")
  const isConnection = (Anthropic.APIConnectionError && e instanceof Anthropic.APIConnectionError) || /APIConnection/.test(e?.constructor?.name || '');
  if (isConnection || /Connection error|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|CERT_|socket hang up|timed out/i.test(`${all} ${cause}`)) return new ProviderError('llm', 'network', msg);
  return e;
}

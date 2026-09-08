# 🎧 منصة جودة المكالمات — Call Quality Platform

منصة بتسحب **بيانات** كل المكالمات من مستودعات الـ CDR (SQL Server) بشكل دوري، تعرضها في شاشة واحدة،
تحوّل اللي يطابق القواعد لنص عن طريق API خارجي، تدوّر على الكلمات المحظورة، تحلل الشكاوى،
وتفتح تذكرة تلقائياً للجهة المسؤولة لحد ما تتقفل.

> **التسجيل الصوتي نفسه لا يُخزَّن هنا أبداً.** بيتشغّل ويتحمّل مباشرة من سيرفر الفرع عبر
> البوابة (`callsearch-gateway`) وقت الطلب، وبيتبعت للـ STT من الذاكرة ويترمي بعدها.

```
 SQL Server (CDRWarehouse)  ──►  collector  ──►  SQLite (بيانات + نصوص + تذاكر)
   10.23.0.221 (HQ)                                   │
   10.25.0.221 (NR)                                   ▼
   10.26.0.14  (KSA)                       worker: rules ► gateway /api/v1 ► STT ► تحليل ► تذكرة
                                                      │
 callsearch-gateway (التسجيلات)  ◄────────────────────┘  (تشغيل مباشر للمستخدم)
```

## المتطلبات
- Node.js 22.13+ (مجرّب على 24)
- وصول شبكي للمستودعات التلاتة (بورت 1433) ولسيرفرات الفروع (نفس اللي في `config.ini` بتاع البوابة)

## مصدر التسجيلات
المنصة بتوصل للتسجيلات بطريقتين، وبتختار تلقائياً:
- **مباشر من الفروع (الافتراضي):** بتقرأ قائمة الفروع ويوزر `dashboard` من `../config.ini` بتاع البوابة،
  وتعمل لوجين على كل فرع زي ما البوابة بتعمل. مفيش مفاتيح إضافية مطلوبة.
- **عبر البوابة:** لو حطيت `gateway.api_key` (سطر في `[apikeys]` بتاع البوابة)، بتستخدم `/api/v1/*`.
  ممكن تفرض أي مصدر بـ `"recordings": { "source": "branches" | "gateway" }`.

ربط المكالمة بالملف: بيبحث برقم العميل في يوم المكالمة، ويطابق بالـ `uniqueid` اللي في اسم الملف
(`out-DST-EXT-YYYYMMDD-HHMMSS-UNIQUEID.wav`)، ولو مش موجود يطابق بالتحويلة وأقرب وقت.

## التشغيل
```bash
cd quality-platform
npm install
copy config.example.json config.json   # وعدّل الباسوردات والمفاتيح
npm start                              # http://localhost:8090
```
الدخول الافتراضي `admin / admin123` وبيطلب تغيير كلمة المرور فوراً.

## الإعدادات (`config.json`)
| القسم | الوصف |
|---|---|
| `warehouses[]` | مستودعات الـ CDR (host / user / password) |
| `gateway` | عنوان البوابة + `api_key` + اسم الهيدر (`X-API-Key` أو `Authorization`) |
| `stt` | المزود: `soniox` (الافتراضي، $0.10/ساعة) / `deepgram` / `openai_compatible` / `elevenlabs` / `custom_http` / `mock` |
| `llm` | المزود: `anthropic` (الافتراضي `claude-opus-5`) / `custom_http` (أي endpoint بشكل OpenAI) / `keywords_only` |
| `collector` | فترة السحب و lookback أول تشغيل |
| `worker` | عدد التحويلات المتوازية |

المفاتيح ممكن تيجي من متغيرات البيئة: `GATEWAY_API_KEY`, `STT_API_KEY`, `LLM_API_KEY` (أو `ANTHROPIC_API_KEY`).
القواعد (أقل مدة، العينة، الحد اليومي، السناترال) بتتظبط من شاشة **الإعدادات** وبتتخزن في الداتابيز.

## الأدوار
| الدور | المكالمات | التذاكر | الإجراء |
|---|---|---|---|
| admin | الكل | الكل | كل شيء |
| quality_specialist أخصائي جودة | الكل + استماع | شركاته | يفتح تذكرة، خطوة 1 |
| quality_manager مدير الجودة | الكل | الكل | خطوة 2، يدير الكلمات المحظورة |
| customer_care عناية العملاء | مكالمات تذاكره | الكل | خطوة 3 |
| sector_manager مدير القطاع | مكالمات تذاكره | الكل | خطوة 4، يقفل بالنتيجة والإجراءات |
| operations إدارة العمليات | مكالمات تذاكره | الكل | مشاهدة فقط (لسحب أرقام العملاء) |
| project_manager مدير المشروع | مكالمات تذاكره | شركاته | مشاهدة فقط |

## مسار الشكوى
التذكرة بتتفتح (تلقائياً من التحليل أو يدوياً من الجودة) على شركة حسب: تحويلة الموظف ← السنترال ← الشركة الافتراضية،
وبعدين بتمشي: **أخصائي جودة الشركة ← مدير الجودة ← عناية العملاء ← مدير القطاع**. كل خطوة صاحبها ينفّذها ويضغط «أنهِ خطوتي وحوّل للتالي»،
ومدير القطاع يقفلها بنص «النتيجة والإجراء المتخذ». إدارة العمليات ومدير المشروع بيستلموا إشعار عند الفتح والإغلاق ويقدروا يسمعوا كل مكالمات العميل.
لو حددت سلسلة أشخاص يدوية لشركة (صفحة الشركات) بتتغلب على السلسلة بالأدوار.

## الـ AI
بيشتغل فقط على المكالمات اللي فيها كلمات محظورة (إعداد `llm_only_flagged`) أو عند «أعد التحليل» يدوياً.

## أوامر مساعدة
```bash
npm run collect          # سحب مرة واحدة
node src/cli.js probe    # فحص الاتصال بالمستودعات والبوابة
node src/cli.js resolve <callId>   # تجربة تحديد ملف التسجيل لمكالمة
node src/cli.js process <callId>   # تحويل + تحليل مكالمة يدوياً
```

## HTTPS
مفعّل افتراضياً (`server.https.enabled`) على البورت 8443، والبورت 8090 بيحوّل تلقائياً لـ HTTPS.
- أول تشغيل بيولّد CA داخلية في `data/certs/ca.crt` وشهادة سيرفر بالأسماء اللي في `server.https.hostnames` (IP وأسماء الدومين).
  وزّع `ca.crt` على أجهزة الموظفين مرة واحدة (متاح للتحميل من `https://<السيرفر>:8443/ca.crt`) عشان المتصفح ميطلعش تحذير.
  لو غيّرت الأسماء بيجدد شهادة السيرفر لوحده.
- لو عندكم شهادة رسمية (من CA الشركة أو Let's Encrypt): حط مساراتها في `cert_file` و`key_file` وهيستخدمها بدل الداخلية.
- للوصول من برا الشركة: افتح البورت 8443 على الفايروول أو خليه ورا VPN. الأفضل VPN لأن المنصة فيها تسجيلات عملاء.

## النشر على السيرفر (Git)
```bash
git clone <رابط-الريبو> D:\quality-platform
cd D:\quality-platform
npm install
copy config.example.json config.json      # وعدّل: المستودعات، Soniox، Anthropic، SMTP، HTTPS hostnames
copy <config.ini بتاع البوابة> branches.ini  # قائمة الفروع ويوزر dashboard (أو عدّل branches.ini_file)
INSTALL_SERVICE.bat                       # كـ Administrator بعد ما تحط nssm.exe
```
`config.json` و`branches.ini` و`data/` و`logs/` مش بيتحطوا في Git (في `.gitignore`)، فالتحديث مش بيلمسهم.
**لتنزيل تحديث:** شغّل `UPDATE_FROM_GIT.bat` كـ Administrator: بيعمل `git pull` و`npm install` ويعيد تشغيل الخدمة.

## تثبيت كخدمة ويندوز
حط `nssm.exe` جنب `INSTALL_SERVICE.bat` وشغّله كـ Administrator. اللوجات في `logs\`.
افتح البورتين في الفايروول:
```bat
netsh advfirewall firewall add rule name="Call Quality HTTPS" dir=in action=allow protocol=TCP localport=8443
netsh advfirewall firewall add rule name="Call Quality HTTP" dir=in action=allow protocol=TCP localport=8090
```

## الملفات
| الملف | الوظيفة |
|---|---|
| `src/server.js` | الويب + الراوتس + تشغيل الـ collector والـ worker |
| `src/collector.js` | سحب الـ CDR من SQL Server وتطبيق القواعد |
| `src/gateway.js` | تحديد التسجيل عبر البوابة (uniqueid أو التحويلة+الوقت) وبثه |
| `src/stt/index.js` | محولات الـ speech-to-text |
| `src/llm/index.js` | محولات التحليل (Anthropic SDK / custom) |
| `src/analyzer.js` | الكلمات المحظورة + التحليل + فتح التذاكر |
| `src/worker.js` | طابور التحويل والتحليل |
| `src/auth.js` | المستخدمون والجلسات |
| `views/` | الواجهة (EJS، عربي RTL) |

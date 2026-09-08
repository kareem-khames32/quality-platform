/**
 * HTTPS certificates. Priority:
 *   1) config.server.https.cert_file + key_file (a certificate you already own: company CA, Let's Encrypt...)
 *   2) an internal CA generated once in data/certs/ (ca.crt to distribute to staff, server.crt/key signed by it,
 *      with SAN entries for every hostname/IP in config.server.https.hostnames). Regenerated when the names change.
 */
import fs from 'node:fs';
import path from 'node:path';
import forge from 'node-forge';
import { config, ROOT } from './config.js';

const log = (...a) => console.log(new Date().toISOString(), '[tls]', ...a);
const dir = path.join(ROOT, 'data', 'certs');

function names() {
  const raw = config.server.https?.hostnames || 'localhost';
  const list = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.includes('localhost')) list.push('localhost');
  return list;
}
const isIp = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

function makeCA() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = String(Date.now());
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 864e5);
  const attrs = [{ name: 'commonName', value: 'Maharah Call Quality CA' }, { name: 'organizationName', value: 'Maharah' }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert, key: keys.privateKey };
}

function makeServerCert(ca, hosts) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = String(Date.now() + 1);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 5 * 365 * 864e5);
  cert.setSubject([{ name: 'commonName', value: hosts[0] }, { name: 'organizationName', value: 'Maharah' }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: hosts.map((h) => (isIp(h) ? { type: 7, ip: h } : { type: 2, value: h })) },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());
  return { cert, key: keys.privateKey };
}

/** Returns { key, cert, ca? } as PEM strings, or null when HTTPS is disabled. */
export function loadTls() {
  const h = config.server.https;
  if (!h?.enabled) return null;
  if (h.cert_file && h.key_file) {
    const cf = path.resolve(ROOT, h.cert_file), kf = path.resolve(ROOT, h.key_file);
    log(`using certificate ${cf}`);
    return { cert: fs.readFileSync(cf, 'utf8'), key: fs.readFileSync(kf, 'utf8'), ca: h.ca_file ? fs.readFileSync(path.resolve(ROOT, h.ca_file), 'utf8') : undefined };
  }
  fs.mkdirSync(dir, { recursive: true });
  const caCrt = path.join(dir, 'ca.crt'), caKey = path.join(dir, 'ca.key'), srvCrt = path.join(dir, 'server.crt'), srvKey = path.join(dir, 'server.key'), namesFile = path.join(dir, 'names.txt');
  const hosts = names();
  let ca;
  if (fs.existsSync(caCrt) && fs.existsSync(caKey)) {
    ca = { cert: forge.pki.certificateFromPem(fs.readFileSync(caCrt, 'utf8')), key: forge.pki.privateKeyFromPem(fs.readFileSync(caKey, 'utf8')) };
  } else {
    log('generating internal CA (data/certs/ca.crt) - distribute ca.crt to staff machines once');
    ca = makeCA();
    fs.writeFileSync(caCrt, forge.pki.certificateToPem(ca.cert));
    fs.writeFileSync(caKey, forge.pki.privateKeyToPem(ca.key));
  }
  const sameNames = fs.existsSync(namesFile) && fs.readFileSync(namesFile, 'utf8').trim() === hosts.join(',');
  if (!(fs.existsSync(srvCrt) && fs.existsSync(srvKey) && sameNames)) {
    log(`generating server certificate for: ${hosts.join(', ')}`);
    const s = makeServerCert(ca, hosts);
    fs.writeFileSync(srvCrt, forge.pki.certificateToPem(s.cert));
    fs.writeFileSync(srvKey, forge.pki.privateKeyToPem(s.key));
    fs.writeFileSync(namesFile, hosts.join(','));
  }
  return { cert: fs.readFileSync(srvCrt, 'utf8'), key: fs.readFileSync(srvKey, 'utf8'), ca: fs.readFileSync(caCrt, 'utf8'), caPath: caCrt };
}

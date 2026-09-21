import { fromBER } from 'asn1js';
import { Certificate, RSAPublicKey } from 'pkijs';
import { hash, byteSize, LIMITS } from './core.js';

const OIDS = {
  '2.5.4.3': 'CN', '2.5.4.6': 'C', '2.5.4.7': 'L', '2.5.4.8': 'ST', '2.5.4.10': 'O', '2.5.4.11': 'OU', '1.2.840.113549.1.9.1': 'emailAddress',
  '1.2.840.113549.1.1.1': 'RSA', '1.2.840.113549.1.1.5': 'SHA-1 / RSA', '1.2.840.113549.1.1.10': 'RSA-PSS', '1.2.840.113549.1.1.11': 'SHA-256 / RSA', '1.2.840.113549.1.1.12': 'SHA-384 / RSA', '1.2.840.113549.1.1.13': 'SHA-512 / RSA',
  '1.2.840.10045.2.1': 'EC', '1.2.840.10045.4.3.2': 'ECDSA / SHA-256', '1.2.840.10045.4.3.3': 'ECDSA / SHA-384', '1.2.840.10045.4.3.4': 'ECDSA / SHA-512',
  '1.2.840.10045.3.1.7': 'P-256', '1.3.132.0.34': 'P-384', '1.3.132.0.35': 'P-521', '1.3.101.112': 'Ed25519', '1.3.101.113': 'Ed448',
  '1.3.6.1.5.5.7.3.1': 'TLS Web Server Authentication', '1.3.6.1.5.5.7.3.2': 'TLS Web Client Authentication', '1.3.6.1.5.5.7.3.3': 'Code Signing', '1.3.6.1.5.5.7.3.4': 'Email Protection', '1.3.6.1.5.5.7.3.8': 'Time Stamping',
};
const oid = value => OIDS[value] ? `${OIDS[value]} (${value})` : value;
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const dn = name => name.typesAndValues.map(x => ({ oid: x.type, name: OIDS[x.type] || x.type, value: x.value.valueBlock.value ?? hex(x.value.valueBlock.valueHexView || []) }));
export function validity(notBefore, notAfter, days = 30, clock = Date.now()) {
  const start = Date.parse(notBefore), end = Date.parse(notAfter), remaining = end - clock;
  return { status: clock < start ? '尚未生效' : clock > end ? '已过期' : remaining <= days * 86400000 ? '即将到期' : '有效期内', remainingDays: remaining / 86400000 };
}
function sanValue(entry) {
  const types = { 0: 'otherName', 1: 'email', 2: 'DNS', 3: 'x400Address', 4: 'directoryName', 5: 'ediPartyName', 6: 'URI', 7: 'IP', 8: 'registeredID' };
  let value = entry.value;
  if (entry.type === 7) {
    const b = value.valueBlock.valueHexView;
    value = b.length === 4 ? Array.from(b).join('.') : b.length === 16 ? Array.from({ length: 8 }, (_, i) => ((b[i * 2] << 8) | b[i * 2 + 1]).toString(16)).join(':') : hex(b);
  } else if (entry.type === 4) value = dn(value);
  else if (typeof value !== 'string') value = value?.toJSON?.() || String(value);
  return { type: types[entry.type] || String(entry.type), value };
}
export function parseDER(bytes, days = 30, clock = Date.now()) {
  if (!bytes.length || bytes.length > LIMITS.cert) throw Error('证书为空或超过 5 MiB');
  const asn = fromBER(bytes);
  if (asn.offset === -1 || asn.offset !== bytes.length) throw Error('无效、截断的 DER 或含有额外数据');
  let cert;
  try { cert = new Certificate({ schema: asn.result }); } catch { throw Error('不是受支持的 X.509 证书'); }
  const notBefore = cert.notBefore.value.toISOString(), notAfter = cert.notAfter.value.toISOString();
  const result = {
    version: cert.version + 1, serialNumber: hex(cert.serialNumber.valueBlock.valueHexView),
    subject: dn(cert.subject), issuer: dn(cert.issuer), notBefore, notAfter, ...validity(notBefore, notAfter, days, clock),
    signatureAlgorithm: oid(cert.signatureAlgorithm.algorithmId), publicKeyAlgorithm: oid(cert.subjectPublicKeyInfo.algorithm.algorithmId),
    publicKeyParameters: '未提供', sha256: hash(bytes).toUpperCase().match(/.{2}/g).join(':'),
    subjectAltName: [], keyUsage: [], extendedKeyUsage: [], basicConstraints: null, extensions: [], warnings: [],
  };
  const pub = cert.subjectPublicKeyInfo;
  try {
    if (pub.algorithm.algorithmId === '1.2.840.113549.1.1.1') {
      const rsaAsn = fromBER(pub.subjectPublicKey.valueBlock.valueHexView);
      const rsa = new RSAPublicKey({ schema: rsaAsn.result });
      const modulus = rsa.modulus.valueBlock.valueHexView; let index = 0; while (modulus[index] === 0) index++;
      result.publicKeyParameters = `${(modulus.length - index - 1) * 8 + (32 - Math.clz32(modulus[index]))} bits`;
    } else if (pub.algorithm.algorithmId === '1.2.840.10045.2.1') result.publicKeyParameters = oid(pub.algorithm.algorithmParams?.valueBlock?.toString() || '未知曲线');
  } catch { result.warnings.push('公钥参数解析失败，其余字段仍可查看'); }
  for (const extension of cert.extensions || []) {
    result.extensions.push({ oid: extension.extnID, critical: extension.critical });
    try {
      const value = extension.parsedValue;
      if (extension.extnID === '2.5.29.17') result.subjectAltName = value.altNames.map(sanValue);
      if (extension.extnID === '2.5.29.19') result.basicConstraints = { ca: !!value.cA, pathLenConstraint: value.pathLenConstraint ?? null };
      if (extension.extnID === '2.5.29.37') result.extendedKeyUsage = value.keyPurposes.map(oid);
      if (extension.extnID === '2.5.29.15') {
        const bits = value.valueBlock.valueHexView;
        result.keyUsage = ['digitalSignature', 'contentCommitment', 'keyEncipherment', 'dataEncipherment', 'keyAgreement', 'keyCertSign', 'cRLSign', 'encipherOnly', 'decipherOnly'].filter((_, i) => bits[Math.floor(i / 8)] & (128 >> (i % 8)));
      }
    } catch { result.warnings.push(`扩展 ${extension.extnID} 无法解析`); }
  }
  return result;
}
export function certificateBlocks(input) {
  if (typeof input !== 'string') {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length > LIMITS.cert) throw Error('证书输入超过 5 MiB');
    const text = new TextDecoder().decode(bytes);
    if (!text.includes('-----BEGIN')) return [{ bytes }];
    input = text;
  }
  if (byteSize(input) > LIMITS.cert) throw Error('证书输入超过 5 MiB');
  if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(input)) throw Error('输入包含私钥，已停止解析；私钥不会保存');
  if (/-----BEGIN (?!CERTIFICATE-----)/.test(input)) throw Error('首版仅支持 CERTIFICATE，不支持 CSR、私钥或 PFX/P12');
  const pieces = input.split('-----BEGIN CERTIFICATE-----');
  if (pieces.length === 1 || pieces[0].trim()) throw Error('请粘贴标准 PEM 证书或上传 DER 文件');
  if (pieces.length - 1 > 50) throw Error('一次最多解析 50 张证书');
  return pieces.slice(1).map(piece => {
    try {
      const end = piece.indexOf('-----END CERTIFICATE-----');
      if (end < 0 || piece.slice(end + 25).trim()) throw Error('PEM 结束标记缺失或存在额外内容');
      const b64 = piece.slice(0, end).replace(/\s/g, '');
      if (!b64 || b64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) throw Error('非法 Base64');
      const binary = atob(b64); if (btoa(binary) !== b64) throw Error('非规范 Base64');
      return { bytes: Uint8Array.from(binary, x => x.charCodeAt(0)) };
    } catch (e) { return { error: e.message }; }
  });
}
export async function parseCertificates(input, days = 30, progress = () => {}) {
  const blocks = certificateBlocks(input), output = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    try { if (block.error) throw Error(block.error); output.push({ index: i + 1, data: parseDER(block.bytes, days) }); }
    catch (e) { output.push({ index: i + 1, error: e.message }); }
    progress(i + 1, blocks.length); await new Promise(resolve => setTimeout(resolve, 0));
  }
  return output;
}

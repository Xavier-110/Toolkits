import test from 'node:test';
import assert from 'node:assert/strict';
import { rootCertificates } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import * as asn1js from 'asn1js';
import { Certificate, AttributeTypeAndValue, Extension, AltName, GeneralName, ExtKeyUsage, BasicConstraints } from 'pkijs';
import { parseCertificates, parseDER, validity, certificateBlocks } from '../src/certificates.js';

test('PEM and DER match Node native X509 fields and fingerprint', async () => {
  for (const pem of rootCertificates.slice(0, 5)) {
    const native = new X509Certificate(pem), der = parseDER(native.raw), parsed = await parseCertificates(pem);
    assert.equal(parsed[0].error, undefined);
    assert.equal(der.sha256, native.fingerprint256); assert.equal(parsed[0].data.sha256, der.sha256);
    assert.equal(Date.parse(der.notAfter), Date.parse(native.validTo)); assert.equal(Date.parse(der.notBefore), Date.parse(native.validFrom));
    assert.ok(der.subject.length > 0); assert.match(der.publicKeyParameters, /bits|P-|Ed|未提供/);
  }
});
test('validity boundaries are exact; day display rounding does not affect state', () => {
  const start = '2026-01-01T00:00:00Z', end = '2026-06-01T00:00:00Z';
  assert.equal(validity(start, end, 30, Date.parse(start) - 1).status, '尚未生效');
  assert.equal(validity(start, end, 30, Date.parse(start)).status, '有效期内');
  assert.equal(validity(start, end, 30, Date.parse(end) - 30 * 86400000).status, '即将到期');
  assert.equal(validity(start, end, 30, Date.parse(end)).status, '即将到期');
  assert.equal(validity(start, end, 30, Date.parse(end) + 1).status, '已过期');
});
test('mixed good and malformed PEM gives isolated per-item errors', async () => {
  const result = await parseCertificates(rootCertificates[0] + '\n-----BEGIN CERTIFICATE-----\n!!!\n-----END CERTIFICATE-----\n' + rootCertificates[1]);
  assert.equal(result.length, 3); assert.ok(result[0].data); assert.match(result[1].error, /Base64/); assert.ok(result[2].data);
});
test('truncated DER, extra bytes and non-cert ASN.1 are rejected', () => {
  const native = new X509Certificate(rootCertificates[0]);
  assert.throws(() => parseDER(native.raw.slice(0, -1))); assert.throws(() => parseDER(Buffer.concat([native.raw, Buffer.from([0])])));
  assert.throws(() => parseDER(Uint8Array.of(0x30, 0)), /X.509/);
});
test('private keys and CSR are rejected before parsing', () => {
  assert.throws(() => certificateBlocks(rootCertificates[0] + '\n-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----'), /私钥/);
  assert.throws(() => certificateBlocks('-----BEGIN CERTIFICATE REQUEST-----\nAA==\n-----END CERTIFICATE REQUEST-----'), /CSR/);
});
test('PEM count and DER input limits are enforced', () => {
  assert.throws(() => certificateBlocks(rootCertificates[0].repeat(51)), /50/);
  assert.throws(() => parseDER(new Uint8Array(5 * 1024 * 1024 + 1)), /5 MiB/);
});
test('EC leaf fields, repeated DN, DNS/IP SAN, usages and unknown OID survive parsing', async () => {
  const cert = new Certificate(); cert.version = 2; cert.serialNumber = new asn1js.Integer({ value: 42 });
  cert.subject.typesAndValues.push(new AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: 'service.example.test' }) }), new AttributeTypeAndValue({ type: '2.5.4.11', value: new asn1js.Utf8String({ value: 'Team A' }) }), new AttributeTypeAndValue({ type: '2.5.4.11', value: new asn1js.Utf8String({ value: 'Team B' }) }));
  cert.issuer.typesAndValues = cert.subject.typesAndValues;
  cert.notBefore.value = new Date('2026-01-01T00:00:00Z'); cert.notAfter.value = new Date('2027-01-01T00:00:00Z');
  const san = new AltName({ altNames: [new GeneralName({ type: 2, value: 'service.example.test' }), new GeneralName({ type: 7, value: new asn1js.OctetString({ valueHex: Uint8Array.of(127, 0, 0, 1).buffer }) })] });
  const eku = new ExtKeyUsage({ keyPurposes: ['1.3.6.1.5.5.7.3.1', '1.2.3.4.5'] });
  cert.extensions = [new Extension({ extnID: '2.5.29.17', extnValue: san.toSchema().toBER(false) }), new Extension({ extnID: '2.5.29.37', extnValue: eku.toSchema().toBER(false) }), new Extension({ extnID: '2.5.29.19', extnValue: new BasicConstraints({ cA: false }).toSchema().toBER(false) }), new Extension({ extnID: '1.2.3.4.999', extnValue: new asn1js.Utf8String({ value: 'unknown extension' }).toBER(false) })];
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey); await cert.sign(keys.privateKey, 'SHA-256');
  const info = parseDER(new Uint8Array(cert.toSchema().toBER(false)));
  assert.match(info.publicKeyParameters, /P-256/); assert.equal(info.subject.filter(x => x.name === 'OU').length, 2);
  assert.deepEqual(info.subjectAltName, [{ type: 'DNS', value: 'service.example.test' }, { type: 'IP', value: '127.0.0.1' }]);
  assert.ok(info.extendedKeyUsage.includes('1.2.3.4.5')); assert.equal(info.basicConstraints.ca, false);
  assert.ok(info.extensions.some(x => x.oid === '1.2.3.4.999')); assert.equal(info.warnings.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
test('format and save normalization warn before sorting env expansions',async()=>{const {conversionJSON}=await import('../src/config-model.js');assert.ok(conversionJSON('env:\n- name: Z\n  value: x\n- name: A\n  value: "$(Z)"').confirmations.length);});
import * as model from '../src/config-model.js';
import {parseYAML as readYAML} from '../src/core.js';
const parseYAML=text=>JSON.parse(JSON.stringify(readYAML(text)));

test('online env conversion uses variable names and sorts by default',()=>{
  const result=model.environmentConversion('env:\n- name: Z\n  value: "true"\n- name: APP_NAME\n  value: demo\n');
  assert.equal(result.format,'json');
  assert.equal(result.text,'{\n  "APP_NAME": "demo",\n  "Z": "true"\n}');
  const yaml=model.environmentConversion(result.text);
  assert.deepEqual(parseYAML(yaml.text),{env:[{name:'APP_NAME',value:'demo'},{name:'Z',value:'true'}]});
  assert.deepEqual(JSON.parse(model.environmentConversion('env: []').text),{});
  assert.deepEqual(parseYAML(model.environmentConversion('{}').text),{env:[]});
});

test('conversion keeps unsafe coercion explicit and rejects lossy structures',()=>{
  const result=model.environmentConversion('{"isSupport":true,"PORT":8080}');
  assert.match(result.confirmations.join(' '),/字符串/);
  assert.deepEqual(parseYAML(result.text),{env:[{name:'PORT',value:'8080'},{name:'isSupport',value:'true'}]});
  for(const text of ['{"x":null}','{"x":{}}','{"x":[]}','env:\n- name: X\n  value: true','env:\n- name: X\n  valueFrom:\n    secretKeyRef: {name: s, key: x}','env:\n- name: X\n  value: a\n- name: X\n  value: b'])assert.throws(()=>model.environmentConversion(text));
  assert.match(model.environmentConversion('{"B":"$(A)","A":"x"}').confirmations.join(' '),/展开/);
  assert.equal(model.environmentConversion('{"B":"b","A":"a"}','none').text.indexOf('name: B')<model.environmentConversion('{"B":"b","A":"a"}','none').text.indexOf('name: A'),true);
  assert.deepEqual(JSON.parse(model.conversionJSON('env:\n- name: APP_NAME\n  value: demo').text),{APP_NAME:'demo'});
  assert.deepEqual(JSON.parse(model.conversionJSON('nested:\n  key: true').text),{nested:{key:true}});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {compareSnapshots,comparisonHTML} from '../src/comparison.js';
test('whole-configuration masks support wrapped and bare historical env comparisons',()=>{
  for(const a of [rows=>({env:rows}),rows=>rows])for(const b of [rows=>({env:rows}),rows=>rows]){
    const left={jsonContent:JSON.stringify(a([{name:'CUSTOM',value:'private-old'}])),itemMetadata:{'/':true}},right={jsonContent:JSON.stringify(b([{name:'CUSTOM',value:'private-new'}])),itemMetadata:{}};
    for(const [l,r]of [[left,right],[right,left]]){const report=compareSnapshots(l,r);assert.equal(report.counts.content,1);assert.ok(!JSON.stringify(report).includes('private-'));assert.ok(!comparisonHTML(report).includes('private-'));assert.ok(JSON.stringify(compareSnapshots(l,r,{reveal:true})).includes('private-'));}
  }
});
test('comparison masks a field when either side treats any env alias as sensitive',()=>{
  for(const [a,b] of [[{CUSTOM:true},{'env:CUSTOM':false}],[{'env:CUSTOM':true},{'!CUSTOM':true}],[{CUSTOM:true},{'!env:CUSTOM':true}]]){
    const left={jsonContent:JSON.stringify({env:[{name:'CUSTOM',value:'private-old'}]}),itemMetadata:a},right={jsonContent:JSON.stringify({env:[{name:'CUSTOM',value:'private-new'}]}),itemMetadata:b};
    for(const [l,r]of [[left,right],[right,left]]){const report=compareSnapshots(l,r);assert.equal(report.changes.length,1);assert.ok(!JSON.stringify(report).includes('private-'));assert.ok(!comparisonHTML(report).includes('private-'));assert.ok(JSON.stringify(compareSnapshots(l,r,{reveal:true})).includes('private-'));}
  }
  const left={jsonContent:'{"PASSWORD":"private-old"}',itemMetadata:{}},right={jsonContent:'{"PASSWORD":"private-new"}',itemMetadata:{'/PASSWORD':false}};assert.ok(!JSON.stringify(compareSnapshots(left,right)).includes('private-'));
});
test('reports detect masked secret changes and never execute input HTML',async()=>{
  const {compareSnapshots,comparisonHTML}=await import('../src/comparison.js');
  const left={jsonContent:'{"password":"old-secret","APP_NAME":"<script>alert(1)</script>","flag":true}',fieldDescriptions:{'/flag':'flag'},itemMetadata:{},versionNumber:1};
  const right={...left,jsonContent:'{"password":"new-secret","APP_NAME":"<script>alert(1)</script>","flag":"true"}',versionNumber:2};
  const report=compareSnapshots(left,right,{generatedBy:'admin',generatedAt:'2026-09-22T00:00:00Z'});
  assert.equal(report.changes.length,2);assert.ok(report.changes.some(x=>x.path==='/password'));
  assert.ok(!JSON.stringify(report).includes('old-secret'));assert.ok(!JSON.stringify(report).includes('new-secret'));
  const html=comparisonHTML(report);assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));assert.match(html,/admin/);
  assert.equal(compareSnapshots(left,{...left,jsonContent:'{"flag":true,"APP_NAME":"<script>alert(1)</script>","password":"old-secret"}'}).changes.length,0);
});

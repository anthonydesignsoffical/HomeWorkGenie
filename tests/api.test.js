'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const port = 3400 + Math.floor(Math.random() * 300);
const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0,10);
const root = path.join(__dirname, '..');
const testData = path.join(root, 'data-test-' + port);
fs.rmSync(testData, {recursive:true, force:true});
const env = { ...process.env, HG_DATA_DIR: testData, PORT: String(port), NODE_ENV: 'test', SESSION_SECRET: crypto.randomBytes(32).toString('hex'), ADMIN_EMAIL: 'hwgenie@proton.me', ADMIN_INITIAL_PASSWORD: 'TestAdmin!2026#1' };
const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore','pipe','pipe'] });
let output=''; child.stdout.on('data',d=>output+=d); child.stderr.on('data',d=>output+=d);
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
async function waitForServer(){for(let i=0;i<50;i++){try{const r=await fetch(`http://127.0.0.1:${port}/api/me`);if(r.status===401)return;}catch{}await sleep(100);}throw new Error('Server did not start: '+output);}
async function req(path, options={}, jar={}){
  const headers={...(options.headers||{})}; if(jar.cookie) headers.cookie=jar.cookie;
  const r=await fetch(`http://127.0.0.1:${port}/api${path}`,{...options,headers});
  const set=r.headers.get('set-cookie'); if(set) jar.cookie=set.split(';')[0];
  const text=await r.text(); let data={}; try{data=text?JSON.parse(text):{}}catch{}
  return {status:r.status,data};
}
function json(method,body){return {method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}}
(async()=>{
  try{
    await waitForServer();
    const admin={};
    let r=await req('/auth/admin-login',json('POST',{email:env.ADMIN_EMAIL,password:env.ADMIN_INITIAL_PASSWORD}),admin); assert.equal(r.status,200); assert(admin.cookie,'admin cookie missing');
    r=await req('/me',{},admin); assert.equal(r.status,200); assert.equal(r.data.user.role,'admin');

    const guest={};
    const b64=Buffer.from('Homework Genie test PDF placeholder').toString('base64');
    r=await req('/quote-requests',json('POST',{name:'Guest Tester',email:'guest@example.com',phone:'+254700000000',service:'Assignment Support',subject:'Biology',title:'Cell Biology Test',description:'Need review support.',deadline:'2026-09-01',length:'5 pages',instructions:'APA',files:[{name:'test.pdf',size:Buffer.from('Homework Genie test PDF placeholder').length,type:'application/pdf',data:b64}]}),guest); assert.equal(r.status,201); const requestId=r.data.request.id; assert(r.data.request.files[0].id);

    const student={};
    r=await req('/auth/register',json('POST',{name:'Student Tester',email:'studenttest@gmail.com',phone:'+254711111111',password:'StudentPass!2026',education:'College'}),student); assert.equal(r.status,201); assert(student.cookie);
    r=await req('/me',{},student); assert.equal(r.status,200); const studentId=r.data.user.id;
    r=await req('/assignments',json('POST',{service:'Research Support',subject:'Economics',title:'Market Analysis',deadline:'2026-09-03',details:'Please review the structure.',instructions:'Use APA.',files:[{name:'assignment.pdf',size:Buffer.from('student assignment').length,type:'application/pdf',data:Buffer.from('student assignment').toString('base64')}] }),student); assert.equal(r.status,201); const assignmentId=r.data.assignment.id;

    r=await req('/admin/dashboard',{},admin); assert.equal(r.status,200); assert(r.data.requests.some(x=>x.id===requestId)); assert(r.data.assignments.some(x=>x.id===assignmentId)); assert(r.data.users.some(x=>x.id===studentId));
    r=await req('/admin/quotes',json('POST',{requestId:requestId,basePrice:120,additionalCharges:10,expiryDate:futureDate,terms:'Guest quote test.'}),admin); assert.equal(r.status,201); const guestQuoteToken=r.data.guestQuoteToken; assert(guestQuoteToken);
    r=await req('/guest/quotes/'+guestQuoteToken,{},{}); assert.equal(r.status,200); assert.equal(r.data.quote.price,130);
    r=await req('/guest/quotes/'+guestQuoteToken+'/respond',json('POST',{action:'accepted'}),{}); assert.equal(r.status,200); assert(r.data.invoice);
    const guestClaim={}; r=await req('/guest/quotes/'+guestQuoteToken+'/claim',json('POST',{name:'Guest Tester',phone:'+254700000000',email:'guest@example.com',password:'GuestPass!2026'}),guestClaim); assert.equal(r.status,201); assert(guestClaim.cookie);
    r=await req('/me',{},guestClaim); assert.equal(r.status,200); assert.equal(r.data.user.email,'guest@example.com');
    r=await req('/admin/quotes',json('POST',{requestId:assignmentId,basePrice:75,additionalCharges:5,expiryDate:futureDate,terms:'Includes academic support.'}),admin); assert.equal(r.status,201); const quoteId=r.data.quote.id; assert.equal(r.data.quote.price,80);
    r=await req('/student/requests',{},student); assert.equal(r.status,200); assert(r.data.quotes.some(q=>q.id===quoteId));
    r=await req(`/quotes/${quoteId}/respond`,json('POST',{action:'accepted'}),student); assert.equal(r.status,200); assert(r.data.invoice); const invoiceId=r.data.invoice.id; assert.equal(r.data.invoice.amount,80);
    r=await req('/student/requests',{},student); assert.equal(r.status,200); assert(r.data.invoices.some(i=>i.id===invoiceId));
    r=await req('/admin/payments',json('POST',{invoiceId,method:'manual',reference:'TEST-PAY-001'}),admin); assert.equal(r.status,200); assert.equal(r.data.invoice.status,'paid');
    r=await req('/admin/requests/'+assignmentId,{},admin); assert.equal(r.status,200); assert.equal(r.data.item.status,'payment_pending'); const fileId=r.data.item.files[0].id;
    r=await req('/files/'+fileId,{},student); assert.equal(r.status,200); const blob=await fetch(`http://127.0.0.1:${port}/api/files/${fileId}`,{headers:{cookie:student.cookie}}); assert.equal(blob.status,200);


    r=await req('/admin/dashboard',{},student); assert.equal(r.status,403);
    r=await req('/auth/forgot-password',json('POST',{email:'studenttest@gmail.com'}),{}); assert.equal(r.status,200); const resetToken=r.data.devResetToken; assert(resetToken);
    r=await req('/auth/reset-password',json('POST',{token:resetToken,password:'NewStudentPass!2026'}),{}); assert.equal(r.status,200);
    r=await req('/auth/reset-password',json('POST',{token:resetToken,password:'AnotherPass!2026'}),{}); assert.equal(r.status,400);
    const student2={}; r=await req('/auth/login',json('POST',{email:'studenttest@gmail.com',password:'NewStudentPass!2026'}),student2); assert.equal(r.status,200);
    r=await req('/admin/password',json('POST',{currentPassword:env.ADMIN_INITIAL_PASSWORD,newPassword:'NewAdminPass!2026'}),admin); assert.equal(r.status,200); assert.equal(r.data.ok,true);
    const admin2={}; r=await req('/auth/admin-login',json('POST',{email:env.ADMIN_EMAIL,password:'NewAdminPass!2026'}),admin2); assert.equal(r.status,200);

    const attacker={}; r=await req('/auth/admin-login',json('POST',{email:env.ADMIN_EMAIL,password:'wrong-password'}),attacker); assert.equal(r.status,401);
    r=await req('/admin/dashboard',{},attacker); assert.equal(r.status,401);
    console.log('ALL API INTEGRATION TESTS PASSED');
  }catch(e){console.error('TEST FAILURE',e);console.error(output);process.exitCode=1;}finally{child.kill('SIGTERM');}
})();

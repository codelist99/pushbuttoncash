import http from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const dataDir=path.join(root,'data');
const dbFile=path.join(dataDir,'events.json');
const port=Number(process.env.PORT||3000);
const adminUser=process.env.ADMIN_USER||'admin';
const adminPassword=process.env.ADMIN_PASSWORD||'change-this-password';
const webhookSecret=process.env.WEBHOOK_SECRET||'change-this-webhook-secret';
const blank=()=>({leads:[],orders:[],events:[]});
let writeQueue=Promise.resolve();

async function load(){try{return JSON.parse(await readFile(dbFile,'utf8'))}catch{return blank()}}
async function save(db){await mkdir(dataDir,{recursive:true});writeQueue=writeQueue.then(()=>writeFile(dbFile,JSON.stringify(db,null,2)));return writeQueue}
const id=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
const clean=v=>String(v??'').trim();
const num=v=>Number.parseFloat(v)||0;
const body=async req=>{let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1e6)throw Error('Payload too large')}return raw?JSON.parse(raw):{}};
const json=(res,status,payload)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(payload))};
const authorized=req=>{const h=req.headers.authorization||'';if(!h.startsWith('Basic '))return false;const [u,p]=Buffer.from(h.slice(6),'base64').toString().split(':');return u===adminUser&&p===adminPassword};
const guard=(req,res)=>{if(authorized(req))return true;res.writeHead(401,{'www-authenticate':'Basic realm="Push Button System Admin"'});res.end('Authentication required');return false};
const page=(items,url)=>{const q=clean(url.searchParams.get('q')).toLowerCase();const p=Math.max(1,Number(url.searchParams.get('page')||1));const size=25;const filtered=q?items.filter(x=>JSON.stringify(x).toLowerCase().includes(q)):items;return{items:filtered.slice((p-1)*size,p*size),page:p,pages:Math.max(1,Math.ceil(filtered.length/size)),total:filtered.length}};
const csv=(rows,fields)=>[fields.join(','),...rows.map(r=>fields.map(f=>`"${clean(r[f]).replaceAll('"','""')}"`).join(','))].join('\n');
const sendCsv=(res,name,text)=>{res.writeHead(200,{'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="${name}"`});res.end(text)};

function normalizeLead(p){return{id:p.id||id(),first_name:clean(p.first_name||p.firstName),last_name:clean(p.last_name||p.lastName),email:clean(p.email).toLowerCase(),phone:clean(p.phone),status:clean(p.status||'opt-in'),source:clean(p.source||p.utm_source),campaign:clean(p.campaign||p.utm_campaign),landing_page:clean(p.landing_page||p.page),email_consent:Boolean(p.email_consent),sms_consent:Boolean(p.sms_consent),transaction_id:clean(p.transaction_id||p._ef_transaction_id),created_at:p.created_at||now()}}
function normalizeOrder(p){const customer=p.customer||p.buyer||{};return{id:p.id||id(),first_name:clean(p.first_name||customer.first_name||customer.firstName),last_name:clean(p.last_name||customer.last_name||customer.lastName),email:clean(p.email||customer.email).toLowerCase(),phone:clean(p.phone||customer.phone),product:clean(p.product||p.product_name||p.title||'Push Button System'),amount:num(p.amount??p.total??p.total_pay),status:clean(p.status||p.payment_status||p.event||'paid').toLowerCase(),transaction_id:clean(p.transaction_id||p.payment_id||p.order_id||p.id),gateway_response:clean(p.gateway_response||p.message),created_at:p.created_at||now(),updated_at:now(),raw_event:clean(p.event||p.type)}}

async function api(req,res,url){
  if(req.method==='POST'&&url.pathname==='/api/track/event'){const p=await body(req),db=await load();db.events.unshift({id:id(),type:clean(p.type||'page_view'),page:clean(p.page),source:clean(p.source),transaction_id:clean(p.transaction_id),created_at:now()});await save(db);return json(res,201,{ok:true})}
  if(req.method==='POST'&&url.pathname==='/api/track/optin'){const p=await body(req),db=await load(),lead=normalizeLead(p);if(!lead.email&&!lead.phone)return json(res,422,{error:'Email or phone is required'});db.leads.unshift(lead);await save(db);return json(res,201,{ok:true,id:lead.id})}
  if(req.method==='POST'&&url.pathname==='/api/webhooks/fanbasis'){if(req.headers['x-webhook-secret']!==webhookSecret)return json(res,401,{error:'Invalid webhook secret'});const p=await body(req),db=await load(),order=normalizeOrder(p.data||p);const existing=db.orders.findIndex(x=>x.transaction_id&&x.transaction_id===order.transaction_id);if(existing>=0)db.orders[existing]={...db.orders[existing],...order,id:db.orders[existing].id};else db.orders.unshift(order);await save(db);return json(res,200,{ok:true,id:order.id})}
  if(url.pathname.startsWith('/api/admin/')&&!guard(req,res))return;
  const db=await load();
  if(req.method==='GET'&&url.pathname==='/api/admin/summary'){const paid=db.orders.filter(o=>['paid','success','completed','succeeded'].includes(o.status));const refunded=db.orders.filter(o=>o.status.includes('refund'));const revenue=paid.reduce((s,o)=>s+o.amount,0)-refunded.reduce((s,o)=>s+o.amount,0);return json(res,200,{leadCount:db.leads.length,buyerCount:new Set(paid.map(o=>o.email||o.phone||o.transaction_id)).size,revenue,conversionRate:db.leads.length?new Set(paid.map(o=>o.email||o.phone)).size/db.leads.length*100:0,attemptCount:db.orders.length,declinedCount:db.orders.filter(o=>['declined','failed'].some(s=>o.status.includes(s))).length,refundCount:refunded.length,pageViewCount:db.events.filter(e=>e.type==='page_view').length})}
  if(req.method==='GET'&&url.pathname==='/api/admin/leads')return json(res,200,page(db.leads,url));
  if(req.method==='GET'&&url.pathname==='/api/admin/orders')return json(res,200,page(db.orders,url));
  if(req.method==='GET'&&url.pathname==='/api/admin/sales'){const map=new Map();for(const o of db.orders){if(!['paid','success','completed','succeeded','refunded','refund'].some(s=>o.status.includes(s)))continue;const k=o.email||o.phone||o.transaction_id;if(!map.has(k))map.set(k,{name:`${o.first_name} ${o.last_name}`.trim(),email:o.email,phone:o.phone,purchases:0,products:new Set(),gross:0,refunds:0,last_purchase:o.updated_at});const x=map.get(k);x.purchases++;x.products.add(o.product);if(o.status.includes('refund'))x.refunds+=o.amount;else x.gross+=o.amount;if(o.updated_at>x.last_purchase)x.last_purchase=o.updated_at}const sales=[...map.values()].map(x=>({...x,products:[...x.products].join(', '),net:x.gross-x.refunds}));return json(res,200,page(sales,url))}
  if(req.method==='GET'&&url.pathname==='/api/admin/leads/export')return sendCsv(res,'pushbutton-optins.csv',csv(db.leads,['first_name','last_name','email','phone','status','source','campaign','landing_page','email_consent','sms_consent','created_at']));
  if(req.method==='GET'&&url.pathname==='/api/admin/sales/export')return sendCsv(res,'pushbutton-sales.csv',csv(db.orders,['first_name','last_name','email','phone','product','amount','status','transaction_id','gateway_response','created_at']));
  return json(res,404,{error:'Not found'});
}

const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.webp':'image/webp','.jpg':'image/jpeg','.json':'application/json'};
async function staticFile(req,res,url){let rel=decodeURIComponent(url.pathname);if(rel==='/')rel='/index.html';if(rel==='/admin'||rel==='/admin/')rel='/admin/index.html';if(rel.startsWith('/admin')&&!guard(req,res))return;const file=path.resolve(root,'.'+rel);if(!file.startsWith(root))return json(res,403,{error:'Forbidden'});try{const s=await stat(file);if(!s.isFile())throw Error();res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream'});createReadStream(file).pipe(res)}catch{json(res,404,{error:'Not found'})}}

http.createServer(async(req,res)=>{try{const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);if(url.pathname.startsWith('/api/'))await api(req,res,url);else await staticFile(req,res,url)}catch(e){console.error(e);json(res,500,{error:'Server error'})}}).listen(port,()=>console.log(`Push Button System running on http://localhost:${port}`));

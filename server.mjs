import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chargeToken, chargeVault, refundTransaction } from './lib/nmi.mjs';
import { upsertLead, addEvent, one, many, run } from './lib/database.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const secret = process.env.SESSION_SECRET || process.env.NMI_PRIVATE_KEY || 'configure-session-secret';
const products = Object.freeze({
  front: { name:'Push Button System', amount:67, next:'/upsell-1.html' },
  oto1: { name:'Gold Package', amount:297, next:'/upsell-2.html' },
  oto2: { name:'Platinum Package', amount:299, next:'/thank-you.html' }
});
const addons = Object.freeze({
  turbo: { name:'Turbo Charged Profits', amount:39 },
  vip: { name:'Premium VIP Support', amount:24 },
  interview: { name:'$300 Million Dollar Interview', amount:95 }
});

const clean = value => String(value ?? '').trim();
const json = (res, status, payload) => { res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); res.end(JSON.stringify(payload)); };
const body = async req => { let raw=''; for await (const chunk of req) { raw+=chunk; if(raw.length>1e6) throw Error('Payload too large'); } return raw ? JSON.parse(raw) : {}; };
const sign = value => crypto.createHmac('sha256', secret).update(value).digest('base64url');
const encode = data => { const value=Buffer.from(JSON.stringify(data)).toString('base64url'); return `${value}.${sign(value)}`; };
const decode = req => {
  const raw=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('pbc_session='))?.slice(12);
  if(!raw) return null;
  const split=raw.lastIndexOf('.'); if(split<1) return null;
  const value=raw.slice(0,split), supplied=raw.slice(split+1), expected=sign(value);
  if(supplied.length!==expected.length || !crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected))) return null;
  try { const data=JSON.parse(Buffer.from(value,'base64url').toString()); return Date.now()-data.createdAt<86400000 ? data : null; } catch { return null; }
};
const setSession = (res,data) => res.setHeader('set-cookie',`pbc_session=${encode(data)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`);
const invoice = product => `PBC-${product}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
const secureEqual=(a,b)=>{const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
const adminToken=()=>crypto.createHmac('sha256',secret).update('pushbuttoncash-admin').digest('base64url');
const adminOk=req=>{const c=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('pbc_admin='));return Boolean(c)&&secureEqual(decodeURIComponent(c.slice(10)),adminToken())};
const setAdmin=res=>res.setHeader('set-cookie',`pbc_admin=${encodeURIComponent(adminToken())}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`);
const leadToken=()=>crypto.createHmac('sha256',secret).update('pushbuttoncash-leads').digest('base64url');
const leadAccessOk=req=>{const c=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('pbc_leads='));return Boolean(c)&&secureEqual(decodeURIComponent(c.slice(10)),leadToken())};
const setLeadAccess=res=>res.setHeader('set-cookie',`pbc_leads=${encodeURIComponent(leadToken())}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`);
const redactLead=item=>({...item,first_name:'••••',last_name:'••••',email:'••••••••',phone:'••••••••',notes:'',redacted:true});
const csvCell=v=>`"${String(v??'').replace(/"/g,'""')}"`;
const range=url=>{const end=new Date(url.searchParams.get('end')||Date.now()),start=new Date(url.searchParams.get('start')||end-86400000);return{start:start.toISOString(),end:end.toISOString()}};

async function api(req,res,url) {
  if(req.method==='POST'&&url.pathname==='/api/admin/login'){const input=await body(req);if(!secureEqual(input.pin,'67'))return json(res,401,{error:'Incorrect PIN'});setAdmin(res);return json(res,200,{ok:true})}
  if(url.pathname.startsWith('/api/admin/')){
    if(!adminOk(req))return json(res,401,{error:'Admin PIN required'});
    const r=range(url),q=clean(url.searchParams.get('q')).slice(0,100),page=Math.max(1,Number(url.searchParams.get('page'))||1),limit=50,offset=(page-1)*limit;
    if(req.method==='POST'&&url.pathname==='/api/admin/leads/unlock'){const input=await body(req);if(!secureEqual(input.pin,'0720'))return json(res,401,{error:'Incorrect lead access PIN'});setLeadAccess(res);return json(res,200,{ok:true})}
    if(req.method==='GET'&&url.pathname==='/api/admin/report'){
      const [e,l,o,spendStats,routes,devices,payments,offers,attribution,trend]=await Promise.all([
        one(`SELECT COUNT(*) FILTER(WHERE type='page_view') views,COUNT(DISTINCT metadata->>'session_id') FILTER(WHERE type='page_view') visitors,COUNT(DISTINCT metadata->>'session_id') FILTER(WHERE type='page_view' AND page='/checkout') checkout_visitors,COUNT(DISTINCT metadata->>'session_id') FILTER(WHERE type='page_view' AND page='/thankyou-e') thankyou_visitors,COUNT(*) FILTER(WHERE type='step2_webinar_click') step2_webinar_clicks,COUNT(DISTINCT metadata->>'session_id') FILTER(WHERE type='step2_webinar_click') step2_webinar_clickers,COUNT(*) FILTER(WHERE type='checkout_start') checkout_started,COUNT(*) FILTER(WHERE type='video_unmute') video_engaged,COUNT(*) FILTER(WHERE type='video_25') video_25,COUNT(*) FILTER(WHERE type='video_50') video_50,COUNT(*) FILTER(WHERE type='video_75') video_75,COUNT(*) FILTER(WHERE type='video_100') video_100 FROM events WHERE created_at BETWEEN $1 AND $2`,[r.start,r.end]),one('SELECT COUNT(*) leads FROM leads WHERE created_at BETWEEN $1 AND $2',[r.start,r.end]),one(`SELECT COUNT(*) attempts,COUNT(*) FILTER(WHERE status='paid') approvals,COUNT(*) FILTER(WHERE status='declined') declines,COUNT(*) FILTER(WHERE status='error') errors,COUNT(DISTINCT lead_id) payment_people,COUNT(DISTINCT lead_id) FILTER(WHERE status='paid') buyers,COUNT(DISTINCT lead_id) FILTER(WHERE status='declined') declined_people,COALESCE(SUM(amount) FILTER(WHERE status='paid'),0) revenue,COALESCE(SUM(refunded_amount) FILTER(WHERE status='paid'),0) refunds FROM orders WHERE updated_at BETWEEN $1 AND $2`,[r.start,r.end]),
        one(`SELECT COALESCE(SUM(amount),0) traffic_spend,COALESCE(SUM(clicks),0) ad_clicks,COALESCE(SUM(impressions),0) ad_impressions FROM traffic_spend WHERE spend_date >= ($1::timestamptz AT TIME ZONE 'America/Chicago')::date AND spend_date <= ($2::timestamptz AT TIME ZONE 'America/Chicago')::date`,[r.start,r.end]),many(`SELECT page path,COUNT(DISTINCT metadata->>'session_id')::int visitors,COUNT(*)::int views FROM events WHERE type='page_view' AND created_at BETWEEN $1 AND $2 GROUP BY page ORDER BY views DESC`,[r.start,r.end]),many(`SELECT COALESCE(metadata->>'device','Unknown') device,COUNT(DISTINCT metadata->>'session_id')::int visitors FROM events WHERE type='page_view' AND created_at BETWEEN $1 AND $2 GROUP BY 1`,[r.start,r.end]),many(`SELECT COALESCE(response_code,'—') response_code,COALESCE(response_message,'No gateway message') response,status,COUNT(*)::int attempts,COUNT(DISTINCT lead_id)::int people,COALESCE(SUM(amount),0) amount FROM orders WHERE updated_at BETWEEN $1 AND $2 GROUP BY 1,2,3 ORDER BY attempts DESC`,[r.start,r.end]),many(`SELECT product_id offer_key,product_name,COUNT(DISTINCT lead_id)::int people,COUNT(*)::int attempts,COUNT(*) FILTER(WHERE status='paid')::int approvals,COUNT(*) FILTER(WHERE status='declined')::int declines,COALESCE(SUM(amount) FILTER(WHERE status='paid'),0) revenue FROM orders WHERE updated_at BETWEEN $1 AND $2 GROUP BY 1,2`,[r.start,r.end]),many(`SELECT COALESCE(NULLIF(utm_source,''),source,'direct') source,COALESCE(NULLIF(utm_campaign,''),'—') campaign,COUNT(*)::int leads,COUNT(*) FILTER(WHERE status='customer')::int buyers FROM leads WHERE created_at BETWEEN $1 AND $2 GROUP BY 1,2`,[r.start,r.end]),many(`SELECT date_trunc('hour',created_at) bucket,COUNT(*) FILTER(WHERE type='page_view')::int views,0::int leads,0::numeric revenue FROM events WHERE created_at BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`,[r.start,r.end])]);
      const n=v=>Number(v||0),s={...Object.fromEntries(Object.entries(e||{}).map(([k,v])=>[k,n(v)])),leads:n(l?.leads),...Object.fromEntries(Object.entries(o||{}).map(([k,v])=>[k,n(v)])),...Object.fromEntries(Object.entries(spendStats||{}).map(([k,v])=>[k,n(v)]))};s.net_revenue=s.revenue-s.refunds;s.approval_rate=s.attempts?+(s.approvals/s.attempts*100).toFixed(1):0;s.conversion=s.visitors?+(s.buyers/s.visitors*100).toFixed(2):0;s.lead_conversion=s.leads?+(s.buyers/s.leads*100).toFixed(2):0;s.aov=s.buyers?s.revenue/s.buyers:0;s.rpv=s.visitors?s.revenue/s.visitors:0;s.rpl=s.leads?s.revenue/s.leads:0;return json(res,200,{range:r,summary:s,routes,devices,payments,offers,attribution,trend});
    }
    if(req.method==='GET'&&url.pathname==='/api/admin/orders'){const params=[r.start,r.end,q],where=`o.updated_at BETWEEN $1 AND $2 AND ($3='' OR CONCAT_WS(' ',l.first_name,l.last_name) ILIKE '%'||$3||'%' OR l.email ILIKE '%'||$3||'%' OR l.phone ILIKE '%'||$3||'%')`,total=Number((await one(`SELECT COUNT(*) total FROM orders o JOIN leads l ON l.id=o.lead_id WHERE ${where}`,params)).total),rows=await many(`SELECT o.*,l.first_name,l.last_name FROM orders o JOIN leads l ON l.id=o.lead_id WHERE ${where} ORDER BY o.updated_at DESC LIMIT $4 OFFSET $5`,[...params,limit,offset]),items=rows;return json(res,200,{items,pagination:{page,pageSize:limit,total,pages:Math.max(1,Math.ceil(total/limit))},range:r})}
    const sold=`SELECT l.id,l.first_name,l.last_name,l.email,l.phone,COUNT(o.id)::int purchase_count,COUNT(o.id) FILTER(WHERE o.transaction_id IS NOT NULL AND o.amount>o.refunded_amount)::int refundable_count,COALESCE(SUM(GREATEST(0,o.amount-o.refunded_amount)) FILTER(WHERE o.transaction_id IS NOT NULL),0) refundable_amount,COALESCE(SUM(o.amount),0) gross_sales,STRING_AGG(o.product_name,', ' ORDER BY o.created_at) products,MIN(o.created_at) first_purchase_at,MAX(o.updated_at) last_purchase_at,COUNT(o.id) FILTER(WHERE o.refunded_amount>0)::int refund_count,COALESCE(SUM(o.refunded_amount),0) refund_amount,COALESCE(SUM(o.amount-o.refunded_amount),0) net_sales FROM leads l JOIN orders o ON o.lead_id=l.id AND o.status='paid' GROUP BY l.id`;
    if(req.method==='GET'&&url.pathname==='/api/admin/leads'){const total=Number((await one(`SELECT COUNT(*) total FROM leads WHERE $1='' OR CONCAT_WS(' ',first_name,last_name) ILIKE '%'||$1||'%' OR email ILIKE '%'||$1||'%' OR phone ILIKE '%'||$1||'%'`,[q])).total),rows=await many(`SELECT *,status display_status FROM leads WHERE $1='' OR CONCAT_WS(' ',first_name,last_name) ILIKE '%'||$1||'%' OR email ILIKE '%'||$1||'%' OR phone ILIKE '%'||$1||'%' ORDER BY created_at DESC LIMIT $2 OFFSET $3`,[q,limit,offset]),locked=!leadAccessOk(req),items=locked?rows.map(redactLead):rows;return json(res,200,{items,locked,pagination:{page,pageSize:limit,total,pages:Math.max(1,Math.ceil(total/limit))}})}
    if(req.method==='GET'&&url.pathname==='/api/admin/buyer-orders'){const leadId=Number(url.searchParams.get('leadId'));if(!Number.isSafeInteger(leadId)||leadId<1)return json(res,400,{error:'Invalid buyer'});const items=await many(`SELECT id,product_name,amount,refunded_amount,refund_status,transaction_id,updated_at FROM orders WHERE lead_id=$1 AND status='paid' ORDER BY updated_at DESC`,[leadId]);return json(res,200,{items})}
    if(req.method==='GET'&&url.pathname==='/api/admin/sales'){const filter=`($1='' OR CONCAT_WS(' ',s.first_name,s.last_name) ILIKE '%'||$1||'%' OR COALESCE(s.email,'') ILIKE '%'||$1||'%' OR COALESCE(s.phone,'') ILIKE '%'||$1||'%' OR (REGEXP_REPLACE($1,'\\D','','g')<>'' AND REGEXP_REPLACE(COALESCE(s.phone,''),'\\D','','g') LIKE '%'||REGEXP_REPLACE($1,'\\D','','g')||'%'))`,total=Number((await one(`SELECT COUNT(*) total FROM (${sold}) s WHERE ${filter}`,[q])).total),rows=await many(`SELECT * FROM (${sold}) s WHERE ${filter} ORDER BY last_purchase_at DESC LIMIT $2 OFFSET $3`,[q,limit,offset]),items=rows.map(item=>Number(item.gross_sales)>500?{...item,email:'',phone:'',contact_hidden:true}:item);return json(res,200,{items,pagination:{page,pageSize:limit,total,pages:Math.max(1,Math.ceil(total/limit))}})}
    if(req.method==='GET'&&url.pathname==='/api/admin/dashboard')return json(res,200,{automations:await many('SELECT * FROM automations ORDER BY created_at DESC'),messages:await many('SELECT * FROM messages ORDER BY created_at DESC LIMIT 100')});
    if(req.method==='GET'&&url.pathname==='/api/admin/traffic-spend'){
      const [orders,spend,items,refundItems,chargebackTotal,chargebackItems]=await Promise.all([
        one(`SELECT COALESCE(SUM(amount),0) gross_revenue,COALESCE(SUM(refunded_amount),0) refunds FROM orders WHERE status='paid'`),
        one(`SELECT COALESCE(SUM(amount),0) total FROM traffic_spend`),
        many(`SELECT id,spend_date,amount,clicks,impressions,source,notes,created_at FROM traffic_spend ORDER BY spend_date DESC,id DESC`),
        many(`SELECT r.id,r.amount,r.action,r.updated_at,l.first_name,l.last_name,l.email,o.product_name FROM refunds r JOIN orders o ON o.id=r.order_id JOIN leads l ON l.id=r.lead_id WHERE r.status='succeeded' ORDER BY r.updated_at DESC,r.id DESC`),
        one(`SELECT COALESCE(SUM(amount),0) total FROM chargebacks WHERE status NOT IN ('won','reversed')`),
        many(`SELECT c.*,l.first_name,l.last_name,l.email,o.product_name FROM chargebacks c LEFT JOIN leads l ON l.id=c.lead_id LEFT JOIN orders o ON o.id=c.order_id ORDER BY c.occurred_at DESC,c.id DESC`)
      ]);
      const grossRevenue=Number(orders?.gross_revenue||0),refunds=Number(orders?.refunds||0),chargebacks=Number(chargebackTotal?.total||0),totalSpend=Number(spend?.total||0);
      return json(res,200,{grossRevenue,refunds,chargebacks,revenue:grossRevenue-refunds,totalSpend,profit:grossRevenue-refunds-chargebacks-totalSpend,items,refundItems,chargebackItems});
    }
    if(req.method==='POST'&&url.pathname==='/api/admin/traffic-spend'){
      const input=await body(req),spendDate=clean(input.spend_date),amount=Math.round(Number(input.amount)*100)/100,clicks=input.clicks===''||input.clicks==null?0:Number(input.clicks),impressions=input.impressions===''||input.impressions==null?0:Number(input.impressions);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(spendDate)||Number.isNaN(Date.parse(`${spendDate}T00:00:00Z`)))return json(res,400,{error:'Choose a valid spend date'});
      if(!Number.isFinite(amount)||amount<=0)return json(res,400,{error:'Enter a traffic spend greater than zero'});
      if(!Number.isSafeInteger(clicks)||clicks<0||!Number.isSafeInteger(impressions)||impressions<0)return json(res,400,{error:'Clicks and impressions must be whole numbers of zero or more'});
      const item=await one(`INSERT INTO traffic_spend(spend_date,amount,clicks,impressions,source,notes) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,spend_date,amount,clicks,impressions,source,notes,created_at`,[spendDate,amount,clicks,impressions,clean(input.source).slice(0,120),clean(input.notes).slice(0,500)]);
      return json(res,201,{ok:true,item});
    }
    const trafficSpendMatch=url.pathname.match(/^\/api\/admin\/traffic-spend\/(\d+)$/);
    if(trafficSpendMatch&&req.method==='PUT'){
      const id=Number(trafficSpendMatch[1]),input=await body(req),spendDate=String(input.spend_date||'').trim(),amount=Math.round(Number(input.amount)*100)/100,clicks=input.clicks===''||input.clicks==null?0:Number(input.clicks),impressions=input.impressions===''||input.impressions==null?0:Number(input.impressions);
      if(!Number.isSafeInteger(id)||id<1)return json(res,400,{error:'Invalid traffic spend entry'});
      if(!/^\d{4}-\d{2}-\d{2}$/.test(spendDate)||Number.isNaN(Date.parse(`${spendDate}T00:00:00Z`)))return json(res,400,{error:'Choose a valid spend date'});
      if(!Number.isFinite(amount)||amount<=0)return json(res,400,{error:'Enter a traffic spend greater than zero'});
      if(!Number.isSafeInteger(clicks)||clicks<0||!Number.isSafeInteger(impressions)||impressions<0)return json(res,400,{error:'Clicks and impressions must be whole numbers of zero or more'});
      const item=await one(`UPDATE traffic_spend SET spend_date=$1,amount=$2,clicks=$3,impressions=$4,source=$5,notes=$6 WHERE id=$7 RETURNING id,spend_date,amount,clicks,impressions,source,notes,created_at`,[spendDate,amount,clicks,impressions,String(input.source||'').trim().slice(0,120),String(input.notes||'').trim().slice(0,500),id]);
      if(!item)return json(res,404,{error:'Traffic spend entry not found'});
      return json(res,200,{ok:true,item});
    }
    if(trafficSpendMatch&&req.method==='DELETE'){
      const id=Number(trafficSpendMatch[1]);if(!Number.isSafeInteger(id)||id<1)return json(res,400,{error:'Invalid traffic spend entry'});
      const item=await one('DELETE FROM traffic_spend WHERE id=$1 RETURNING id',[id]);if(!item)return json(res,404,{error:'Traffic spend entry not found'});
      return json(res,200,{ok:true,id});
    }
    if(req.method==='POST'&&url.pathname==='/api/admin/leads'){const input=await body(req),result=await upsertLead({...input,source:'admin'});await addEvent(result.lead.id,'opt_in',{metadata:{source:'admin'}});return json(res,201,{ok:true,id:Number(result.lead.id)})}
    if(req.method==='POST'&&url.pathname==='/api/admin/automations'){const input=await body(req);if(!['email','sms'].includes(input.channel))return json(res,400,{error:'Invalid channel'});await run(`INSERT INTO automations(name,channel,delay_minutes,subject,message,enabled,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,NOW(),NOW())`,[clean(input.name),input.channel,Number(input.delay_minutes)||0,clean(input.subject),clean(input.message),Boolean(input.enabled)]);return json(res,201,{ok:true})}
    if(req.method==='POST'&&url.pathname==='/api/admin/refunds'){
      const input=await body(req);if(!secureEqual(input.pin,'67'))return json(res,401,{error:'Incorrect confirmation PIN'});
      const orderId=Number(input.orderId);if(!Number.isSafeInteger(orderId)||orderId<1)return json(res,400,{error:'Invalid order'});
      const current=await one(`SELECT * FROM orders WHERE id=$1 AND status='paid'`,[orderId]);if(!current?.transaction_id)return json(res,409,{error:'Only approved NMI transactions can be refunded'});
      const remaining=Number(current.amount)-Number(current.refunded_amount||0),requested=input.amount==null||input.amount===''?remaining:Number(input.amount),amount=Math.round(requested*100)/100;if(!Number.isFinite(amount)||amount<=0||amount>remaining)return json(res,400,{error:'Invalid refund amount'});
      const reserved=(await run(`UPDATE orders SET refunded_amount=refunded_amount+$1,refund_status='processing',refund_updated_at=NOW() WHERE id=$2 AND status='paid' AND refund_status<>'processing' AND amount-refunded_amount >= $1 RETURNING *`,[amount,orderId]))[0];if(!reserved)return json(res,409,{error:'Refund exceeds the remaining balance or another refund is processing'});
      let audit;try{audit=(await run(`INSERT INTO refunds(order_id,lead_id,amount,status,original_transaction_id,created_at,updated_at) VALUES($1,$2,$3,'processing',$4,NOW(),NOW()) RETURNING *`,[orderId,reserved.lead_id,amount,reserved.transaction_id]))[0]}catch(error){await run(`UPDATE orders SET refunded_amount=GREATEST(0,refunded_amount-$1),refund_status=CASE WHEN refunded_amount-$1<=0 THEN '' ELSE 'partially_refunded' END,refund_updated_at=NOW() WHERE id=$2`,[amount,orderId]);throw error}
      let result;try{result=await refundTransaction({transactionId:reserved.transaction_id,amount})}catch(error){await run(`UPDATE refunds SET status='failed',response_message=$1,updated_at=NOW() WHERE id=$2`,[String(error.message).slice(0,500),audit.id]);await run(`UPDATE orders SET refunded_amount=GREATEST(0,refunded_amount-$1),refund_status=CASE WHEN refunded_amount-$1<=0 THEN '' ELSE 'partially_refunded' END,refund_updated_at=NOW() WHERE id=$2`,[amount,orderId]);return json(res,409,{error:error.message})}
      try{await run(`UPDATE refunds SET status='succeeded',gateway_transaction_id=$1,response_message='Refunded successfully',updated_at=NOW() WHERE id=$2`,[result.transactionId,audit.id]);await run(`UPDATE orders SET refund_status=CASE WHEN refunded_amount>=amount THEN 'refunded' ELSE 'partially_refunded' END,refund_updated_at=NOW() WHERE id=$1`,[orderId]);await addEvent(reserved.lead_id,'refund',{value:amount,product_id:reserved.product_id,transaction_id:result.transactionId,metadata:{gateway:'nmi',order_id:orderId,original_transaction_id:reserved.transaction_id}})}catch(error){console.error('NMI refund succeeded but dashboard audit failed',error);return json(res,200,{ok:true,action:'refund',amount,transactionId:result.transactionId,warning:'NMI completed the refund, but dashboard synchronization requires review.'})}
      return json(res,200,{ok:true,action:'refund',amount,transactionId:result.transactionId});
    }
    if(req.method==='GET'&&url.pathname==='/api/admin/leads/export'&&!leadAccessOk(req))return json(res,403,{error:'Lead access PIN required'});
    if(req.method==='GET'&&(url.pathname==='/api/admin/leads/export'||url.pathname==='/api/admin/sales/export')){const rows=url.pathname.includes('sales')?await many(`SELECT * FROM (${sold}) s WHERE gross_sales<=500`):await many('SELECT * FROM leads ORDER BY created_at DESC'),keys=rows[0]?Object.keys(rows[0]):[],csv='\uFEFF'+[keys.map(csvCell).join(','),...rows.map(x=>keys.map(k=>csvCell(x[k])).join(','))].join('\r\n');res.writeHead(200,{'content-type':'text/csv','content-disposition':'attachment; filename="pushbuttoncash-export.csv"'});return res.end(csv)}
    return json(res,404,{error:'Not found'});
  }
  if(req.method==='GET' && url.pathname==='/api/checkout/config') return json(res,200,{gateway:'nmi',publicKey:process.env.NMI_PUBLIC_KEY||'',baseAmount:products.front.amount,product:{name:products.front.name,amount:products.front.amount},addons});
  if(req.method==='POST' && url.pathname==='/api/checkout') {
    const input=await body(req);
    if(!input.consent) return json(res,400,{error:'Payment authorization is required'});
    if(!input.paymentToken) return json(res,400,{error:'Secure card token is required'});
    const customer={first_name:clean(input.first_name),last_name:clean(input.last_name),email:clean(input.email),phone:clean(input.phone),address:clean(input.address),city:clean(input.city),state:clean(input.state),zip:clean(input.zip)};
    if(!customer.first_name||!customer.last_name||!customer.email||!customer.phone||!customer.address||!customer.city||!customer.state||!customer.zip) return json(res,400,{error:'Complete all contact and billing fields'});
    const selected=[...new Set(Array.isArray(input.addons)?input.addons:[])].filter(key=>addons[key]);
    const amount=products.front.amount+selected.reduce((sum,key)=>sum+addons[key].amount,0);
    const productName=[products.front.name,...selected.map(key=>addons[key].name)].join(' + ');
    const checkoutProduct={name:productName,amount};
    const {lead}=await upsertLead({...customer,source:'checkout',landing_page:'/checkout',utm_source:clean(input.utm_source),utm_campaign:clean(input.utm_campaign),tid:clean(input.tid)});
    const existing=await one(`SELECT * FROM orders WHERE lead_id=$1 AND product_id='front'`,[lead.id]);
    if(existing?.status==='paid')return json(res,409,{error:'This order has already been completed. Please check your email for access details.'});
    let order=(await run(`INSERT INTO orders(lead_id,product_id,product_name,amount,status,created_at,updated_at) VALUES($1,'front',$2,$3,'pending',NOW(),NOW()) ON CONFLICT(lead_id,product_id) DO UPDATE SET product_name=EXCLUDED.product_name,amount=EXCLUDED.amount,status='pending',transaction_id=NULL,response_code='',response_message='',updated_at=NOW() RETURNING *`,[lead.id,productName,amount]))[0];
    try {
      const payment=await chargeToken({product:checkoutProduct,paymentToken:input.paymentToken,customer,invoice:invoice('front')});
      await run(`UPDATE orders SET status='paid',transaction_id=$1,response_code=$2,response_message='Approved',updated_at=NOW() WHERE id=$3`,[payment.transactionId,payment.responseCode,order.id]);await addEvent(lead.id,'sale',{value:amount,product_id:'front',transaction_id:payment.transactionId,metadata:{gateway:'nmi',addons:selected}});
      setSession(res,{...customer,customerVaultId:payment.customerVaultId,initialTransactionId:payment.transactionId,purchased:['front'],createdAt:Date.now()});
      return json(res,200,{ok:true,next:products.front.next,transactionId:payment.transactionId});
    } catch(error) {await run(`UPDATE orders SET status='declined',response_code=$1,response_message=$2,updated_at=NOW() WHERE id=$3`,[error.code||'',error.message,order.id]);return json(res,402,{error:error.message,code:error.code||'declined'}); }
  }
  if(req.method==='POST' && url.pathname==='/api/purchase') {
    const input=await body(req), session=decode(req), product=products[input.product];
    if(!session) return json(res,401,{error:'Your secure checkout session expired. Please complete the initial checkout again.'});
    if(!product || input.product==='front') return json(res,400,{error:'Unknown upgrade'});
    if(session.purchased.includes(input.product)) return json(res,200,{ok:true,next:product.next,alreadyPurchased:true});
    const {lead}=await upsertLead({...session,source:'checkout'});
    const existing=await one(`SELECT * FROM orders WHERE lead_id=$1 AND product_id=$2`,[lead.id,input.product]);
    if(existing?.status==='paid')return json(res,200,{ok:true,next:product.next,alreadyPurchased:true});
    let order=(await run(`INSERT INTO orders(lead_id,product_id,product_name,amount,status,created_at,updated_at) VALUES($1,$2,$3,$4,'pending',NOW(),NOW()) ON CONFLICT(lead_id,product_id) DO UPDATE SET status='pending',response_code='',response_message='',updated_at=NOW() RETURNING *`,[lead.id,input.product,product.name,product.amount]))[0];
    try {
      const payment=await chargeVault({product,customerVaultId:session.customerVaultId,initialTransactionId:session.initialTransactionId,invoice:invoice(input.product)});
      await run(`UPDATE orders SET status='paid',transaction_id=$1,response_code=$2,response_message='Approved',updated_at=NOW() WHERE id=$3`,[payment.transactionId,payment.responseCode,order.id]);await addEvent(lead.id,'sale',{value:product.amount,product_id:input.product,transaction_id:payment.transactionId,metadata:{gateway:'nmi',one_click:true}});
      setSession(res,{...session,purchased:[...session.purchased,input.product]});
      return json(res,200,{ok:true,next:product.next,transactionId:payment.transactionId});
    } catch(error) {await run(`UPDATE orders SET status='declined',response_code=$1,response_message=$2,updated_at=NOW() WHERE id=$3`,[error.code||'',error.message,order.id]);return json(res,402,{error:error.message,code:error.code||'declined'}); }
  }
  if(req.method==='POST'&&url.pathname==='/api/events'){const input=await body(req);await addEvent(null,clean(input.type)||'event',{page:clean(input.page),metadata:input});return json(res,201,{ok:true})}
  if(req.method==='POST'&&url.pathname==='/api/leads'){const input=await body(req),result=await upsertLead(input);await addEvent(result.lead.id,'opt_in',{page:input.landing_page,metadata:input});return json(res,201,{ok:true,id:Number(result.lead.id)})}
  return json(res,404,{error:'Not found'});
}

const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml'};
async function staticFile(req,res,url) {
  let rel=decodeURIComponent(url.pathname);
  if(rel==='/thankyou'||rel==='/thankyou/'){
    res.writeHead(307,{'location':`/thank-you.html${url.search}`,'cache-control':'no-store'});
    return res.end();
  }
  if(rel==='/admin'||rel==='/admin/') rel=adminOk(req)?'/public/admin.html':'/public/admin-login.html';
  if(rel==='/') rel='/index.html';
  else if(rel==='/checkout'||rel==='/checkout/') rel='/checkout.html';
  else if(rel.startsWith('/assets/')) rel='/public/'+rel.slice(8);
  else if(!path.extname(rel)) rel=rel.replace(/\/$/,'')+'.html';
  const file=path.resolve(root,'.'+rel);
  if(!file.startsWith(root)) return json(res,403,{error:'Forbidden'});
  try { const info=await stat(file); if(!info.isFile()) throw Error(); if(path.extname(file)==='.html'){let html=await readFile(file,'utf8');if(!html.includes('/assets/tracker.js'))html=html.replace(/<\/body>/i,'<script src="/assets/tracker.js" defer></script></body>');res.writeHead(200,{'content-type':types['.html'],'cache-control':'no-store'});return res.end(html)}res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream','cache-control':'public, max-age=60'}); createReadStream(file).pipe(res); }
  catch { json(res,404,{error:'Not found'}); }
}

export async function handler(req,res) {
  try { let url=new URL(req.url,`http://${req.headers.host||'localhost'}`); const rewritten=url.searchParams.get('__path'); if(rewritten){const original=url;url=new URL('/'+rewritten.replace(/^\//,''),url);for(const [key,value] of original.searchParams)if(key!=='__path')url.searchParams.append(key,value)} if(url.pathname.startsWith('/api/')) await api(req,res,url); else await staticFile(req,res,url); }
  catch(error) { console.error(error); json(res,500,{error:'Server error'}); }
}

export default handler;

if(!process.env.VERCEL) http.createServer(handler).listen(port,()=>console.log(`Push Button Cash running at http://localhost:${port}`));

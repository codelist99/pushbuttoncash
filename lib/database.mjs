import { neon } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const sql = neon(process.env.DATABASE_URL);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function query(text, params = []) {
  for (let attempt=1;attempt<=3;attempt++) {
    try { return await sql.query(text, params); }
    catch (error) {
      const connectionFailure=/Error connecting to database|fetch failed|UND_ERR_SOCKET/i.test(`${error?.message} ${error?.sourceError?.message} ${error?.cause?.code}`);
      if(!connectionFailure||attempt===3)throw error;
      await pause(attempt*150);
    }
  }
}
const stamp = () => new Date().toISOString();
const clean = value => String(value ?? '').trim();

const schema = `
    CREATE TABLE IF NOT EXISTS leads (
      id BIGSERIAL PRIMARY KEY, email TEXT UNIQUE, phone TEXT UNIQUE, first_name TEXT DEFAULT '', last_name TEXT DEFAULT '',
      source TEXT DEFAULT 'website', status TEXT DEFAULT 'new', tags TEXT DEFAULT '', notes TEXT DEFAULT '',
      email_consent BOOLEAN DEFAULT FALSE, sms_consent BOOLEAN DEFAULT FALSE, unsubscribed BOOLEAN DEFAULT FALSE,
      aid TEXT DEFAULT '', tid TEXT DEFAULT '', utm_source TEXT DEFAULT '', utm_campaign TEXT DEFAULT '',
      landing_page TEXT DEFAULT '', ip TEXT DEFAULT '', created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY, lead_id BIGINT REFERENCES leads(id), type TEXT NOT NULL, value NUMERIC(12,2) DEFAULT 0,
      currency TEXT DEFAULT 'USD', product_id TEXT DEFAULT '', transaction_id TEXT DEFAULT '', page TEXT DEFAULT '',
      metadata JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS events_transaction_type_unique ON events(transaction_id,type) WHERE transaction_id <> '';
    CREATE TABLE IF NOT EXISTS automations (
      id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, channel TEXT NOT NULL, delay_minutes INTEGER NOT NULL DEFAULT 5,
      subject TEXT DEFAULT '', message TEXT NOT NULL, enabled BOOLEAN DEFAULT FALSE, trigger_event TEXT DEFAULT 'opt_in',
      created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY, lead_id BIGINT NOT NULL REFERENCES leads(id), automation_id BIGINT REFERENCES automations(id),
      channel TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT DEFAULT '', body TEXT NOT NULL, status TEXT DEFAULT 'scheduled',
      provider_id TEXT DEFAULT '', error TEXT DEFAULT '', scheduled_at TIMESTAMPTZ NOT NULL, sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gateway_profiles (
      id BIGSERIAL PRIMARY KEY, lead_id BIGINT NOT NULL UNIQUE REFERENCES leads(id), gateway TEXT NOT NULL DEFAULT 'authorize_net',
      customer_profile_id TEXT NOT NULL, payment_profile_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY, lead_id BIGINT NOT NULL REFERENCES leads(id), product_id TEXT NOT NULL, product_name TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', status TEXT NOT NULL DEFAULT 'pending',
      transaction_id TEXT UNIQUE, response_code TEXT DEFAULT '', response_message TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, UNIQUE(lead_id,product_id)
    );
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_status TEXT NOT NULL DEFAULT '';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_updated_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS refunds (
      id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES orders(id), lead_id BIGINT NOT NULL REFERENCES leads(id),
      action TEXT NOT NULL DEFAULT 'refund', amount NUMERIC(12,2) NOT NULL, status TEXT NOT NULL DEFAULT 'processing',
      original_transaction_id TEXT NOT NULL, gateway_transaction_id TEXT UNIQUE, response_message TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS traffic_spend (
      id BIGSERIAL PRIMARY KEY, spend_date DATE NOT NULL, amount NUMERIC(12,2) NOT NULL CHECK(amount > 0),
      source TEXT DEFAULT '', notes TEXT DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE traffic_spend ADD COLUMN IF NOT EXISTS clicks BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE traffic_spend ADD COLUMN IF NOT EXISTS impressions BIGINT NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS traffic_spend_date_idx ON traffic_spend(spend_date DESC, id DESC);
    CREATE TABLE IF NOT EXISTS chargebacks (
      id BIGSERIAL PRIMARY KEY, order_id BIGINT REFERENCES orders(id), lead_id BIGINT REFERENCES leads(id),
      amount NUMERIC(12,2) NOT NULL CHECK(amount > 0), status TEXT NOT NULL DEFAULT 'open',
      processor_case_id TEXT UNIQUE, transaction_id TEXT DEFAULT '', reason TEXT DEFAULT '',
      occurred_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE chargebacks ADD COLUMN IF NOT EXISTS processor_type TEXT NOT NULL DEFAULT 'chargeback';
    ALTER TABLE chargebacks ADD COLUMN IF NOT EXISTS attention BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE chargebacks ADD COLUMN IF NOT EXISTS fraud BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE chargebacks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    CREATE INDEX IF NOT EXISTS chargebacks_occurred_idx ON chargebacks(occurred_at DESC, id DESC);
  `;
let readyPromise;
async function ensureReady() {
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
  for (const statement of schema.split(';').map(value => value.trim()).filter(Boolean)) await query(statement);
  })().catch(error=>{readyPromise=null;throw error});
  return readyPromise;
}
export const ready={then:(resolve,reject)=>ensureReady().then(resolve,reject)};

export async function one(text, params = []) { await ready; return (await query(text, params))[0] || null; }
export async function many(text, params = []) { await ready; return query(text, params); }
export async function run(text, params = []) { await ready; return query(text, params); }

export async function upsertLead(input = {}) {
  await ready;
  const email=clean(input.email).toLowerCase() || null, phone=clean(input.phone) || null;
  if (!email && !phone) throw new Error('Email or phone is required');
  let lead = await one('SELECT * FROM leads WHERE ($1::text IS NOT NULL AND email=$1) OR ($2::text IS NOT NULL AND phone=$2) LIMIT 1',[email,phone]);
  const values=[email,phone,clean(input.first_name||input.name),clean(input.last_name),clean(input.source),Boolean(input.email_consent),Boolean(input.sms_consent),clean(input.aid),clean(input.tid),clean(input.utm_source),clean(input.utm_campaign),clean(input.landing_page),clean(input.ip),stamp()];
  if (lead) {
    lead=(await query(`UPDATE leads SET email=COALESCE(NULLIF($1,''),email),phone=COALESCE(NULLIF($2,''),phone),first_name=COALESCE(NULLIF($3,''),first_name),last_name=COALESCE(NULLIF($4,''),last_name),source=COALESCE(NULLIF($5,''),source),email_consent=(email_consent OR $6),sms_consent=(sms_consent OR $7),aid=COALESCE(NULLIF($8,''),aid),tid=COALESCE(NULLIF($9,''),tid),utm_source=COALESCE(NULLIF($10,''),utm_source),utm_campaign=COALESCE(NULLIF($11,''),utm_campaign),landing_page=COALESCE(NULLIF($12,''),landing_page),ip=COALESCE(NULLIF($13,''),ip),updated_at=$14 WHERE id=$15 RETURNING *`,[...values,lead.id]))[0];
    return {lead,created:false};
  }
  try {
    lead=(await query(`INSERT INTO leads(email,phone,first_name,last_name,source,email_consent,sms_consent,aid,tid,utm_source,utm_campaign,landing_page,ip,created_at,updated_at) VALUES($1,$2,$3,$4,COALESCE(NULLIF($5,''),'website'),$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING *`,values))[0];
    return {lead,created:true};
  } catch (error) {
    if (error.code !== '23505') throw error;
    return upsertLead(input);
  }
}

export async function addEvent(leadId,type,input={}) {
  await ready;
  const rows=await query(`INSERT INTO events(lead_id,type,value,currency,product_id,transaction_id,page,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT DO NOTHING RETURNING id`,[leadId||null,type,Number(input.value||0),clean(input.currency)||'USD',clean(input.product_id),clean(input.transaction_id),clean(input.page),JSON.stringify(input.metadata||{}),stamp()]);
  if(leadId&&['sale','conversion'].includes(type))await query("UPDATE leads SET status='customer',updated_at=$1 WHERE id=$2",[stamp(),leadId]);
  return rows.length>0;
}

export async function scheduleAutomations(lead,trigger='opt_in') {
  const rules=await many('SELECT * FROM automations WHERE enabled=TRUE AND trigger_event=$1',[trigger]);
  for(const rule of rules){const recipient=rule.channel==='sms'?lead.phone:lead.email,consent=rule.channel==='sms'?lead.sms_consent:lead.email_consent;if(!recipient||!consent||lead.unsubscribed)continue;const scheduled=new Date(Date.now()+rule.delay_minutes*60000).toISOString();await query('INSERT INTO messages(lead_id,automation_id,channel,recipient,subject,body,scheduled_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[lead.id,rule.id,rule.channel,recipient,rule.subject,rule.message,scheduled,stamp()])}
}

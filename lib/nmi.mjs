const endpoint = process.env.NMI_ENDPOINT || 'https://secure.nmi.com/api/transact.php';

function key() {
  if (!process.env.NMI_PRIVATE_KEY) throw new Error('NMI is not configured');
  return process.env.NMI_PRIVATE_KEY;
}

async function request(values) {
  const payload = new URLSearchParams({ security_key:key(), ...values });
  const response = await fetch(endpoint, {
    method:'POST',
    headers:{ 'content-type':'application/x-www-form-urlencoded' },
    body:payload
  });
  const result = Object.fromEntries(new URLSearchParams(await response.text()));
  if (result.response !== '1') {
    const error = new Error(result.responsetext || 'Payment was declined');
    error.code = result.response_code || result.response || '';
    error.transactionId = result.transactionid || '';
    throw error;
  }
  return {
    transactionId:result.transactionid || '',
    responseCode:result.response_code || result.response || '1',
    responseText:result.responsetext || 'Approved',
    customerVaultId:result.customer_vault_id || ''
  };
}

export function chargeToken({ paymentToken, amount, customer, description, orderId }) {
  return request({
    type:'sale',
    payment_token:paymentToken,
    amount:Number(amount).toFixed(2),
    customer_vault:'add_customer',
    orderid:String(orderId).slice(0,30),
    order_description:String(description).slice(0,255),
    first_name:customer.first_name || '',
    last_name:customer.last_name || '',
    email:customer.email || '',
    phone:customer.phone || '',
    address1:customer.address || '',
    city:customer.city || '',
    state:customer.state || '',
    zip:customer.zip || '',
    country:'US'
  });
}

export function chargeVault({ customerVaultId, amount, description, orderId }) {
  return request({
    type:'sale',
    customer_vault_id:customerVaultId,
    amount:Number(amount).toFixed(2),
    orderid:String(orderId).slice(0,30),
    order_description:String(description).slice(0,255)
  });
}

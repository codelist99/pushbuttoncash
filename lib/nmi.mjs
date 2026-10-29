const endpoint = () => process.env.NMI_ENV === 'sandbox'
  ? 'https://sandbox.nmi.com/api/transact.php'
  : 'https://secure.nmi.com/api/transact.php';

async function request(fields) {
  if (!process.env.NMI_PRIVATE_KEY) throw new Error('NMI is not configured');
  const response = await fetch(endpoint(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ security_key: process.env.NMI_PRIVATE_KEY, ...fields })
  });
  const data = Object.fromEntries(new URLSearchParams(await response.text()));
  if (!response.ok || data.response !== '1') {
    const error = new Error(data.responsetext || `Gateway HTTP ${response.status}`);
    error.code = data.response_code || data.response || 'declined';
    error.transactionId = data.transactionid || '';
    throw error;
  }
  return {
    transactionId: data.transactionid || '',
    customerVaultId: data.customer_vault_id || '',
    responseCode: data.response_code || data.response,
    responseText: data.responsetext || 'Approved'
  };
}

const common = ({ product, invoice }) => ({
  type: 'sale',
  amount: product.amount.toFixed(2),
  currency: 'USD',
  orderid: String(invoice).slice(0, 30),
  order_description: product.name.slice(0, 255)
});

export function chargeToken({ product, paymentToken, customer, invoice }) {
  return request({
    ...common({ product, invoice }),
    payment_token: paymentToken,
    customer_vault: 'add_customer',
    firstname: customer.first_name,
    lastname: customer.last_name,
    email: customer.email,
    phone: customer.phone,
    address1: customer.address,
    city: customer.city,
    state: customer.state,
    zip: customer.zip,
    country: 'US'
  });
}

export function chargeVault({ product, customerVaultId, initialTransactionId, invoice }) {
  return request({
    ...common({ product, invoice }),
    customer_vault_id: String(customerVaultId),
    initiated_by: 'customer',
    stored_credential_indicator: 'used',
    initial_transaction_id: String(initialTransactionId || '')
  });
}

export function refundTransaction({ transactionId, amount }) {
  return request({ type:'refund', transactionid:String(transactionId), amount:Number(amount).toFixed(2) });
}

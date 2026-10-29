const qs=new URLSearchParams(location.search);
const passParams=()=>qs.toString()?`?${qs.toString()}`:'';
const money=n=>`$${n.toFixed(2)}`;
const byId=id=>document.getElementById(id);

function initCheckout(){
  const form=byId('paymentForm'),button=byId('checkoutButton'),errorBox=byId('paymentError');
  const boxes=[...document.querySelectorAll('[data-addon]')];
  const total=document.querySelector('[data-total]'),rows=document.querySelector('[data-order-items]');
  let processing=false,config;
  const selected=()=>boxes.filter(box=>box.checked).map(box=>box.dataset.addon);
  const calculate=()=>{let amount=67,html='<div class="product"><span>Push Button System</span><strong>$67.00</strong></div>';boxes.forEach(box=>{if(box.checked){const price=Number(box.dataset.price);amount+=price;html+=`<div class="product"><span>${box.dataset.title}</span><strong>${money(price)}</strong></div>`}});total.textContent=money(amount);rows.innerHTML=html;if(config&&!processing)button.textContent=`COMPLETE SECURE ORDER — ${money(amount)}`};
  const showError=message=>{processing=false;errorBox.textContent=message;button.disabled=false;calculate()};
  async function pay(response){if(processing)return;processing=true;errorBox.textContent='';button.disabled=true;button.textContent='SECURELY PROCESSING…';try{const payload={paymentToken:response.token,addons:selected(),first_name:byId('firstName').value,last_name:byId('lastName').value,email:byId('email').value,phone:byId('phone').value,address:byId('address').value,city:byId('city').value,state:byId('state').value,zip:byId('zip').value,consent:byId('consent').checked,utm_source:qs.get('utm_source')||'',utm_campaign:qs.get('utm_campaign')||'',tid:qs.get('tid')||qs.get('_ef_transaction_id')||''};const result=await fetch('/api/checkout',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}),data=await result.json();if(!result.ok)throw Error(data.error||'Payment could not be completed');location.href=data.next+passParams()}catch(error){showError(error.message)}}
  boxes.forEach(box=>box.addEventListener('change',calculate));calculate();
  fetch('/api/checkout/config').then(r=>r.json().then(data=>{if(!r.ok)throw Error(data.error||'Checkout is unavailable');return data})).then(data=>{config=data;if(!data.publicKey)throw Error('Secure checkout is not configured');const script=document.createElement('script');script.src='https://secure.nmi.com/token/Collect.js';script.dataset.tokenizationKey=data.publicKey;script.onload=()=>{CollectJS.configure({variant:'inline',paymentSelector:'#checkoutButton',fields:{ccnumber:{selector:'#cardNumber',title:'Card Number',placeholder:'Card number'},ccexp:{selector:'#cardExpiration',title:'Expiration',placeholder:'MM / YY'},cvv:{selector:'#cardCvv',title:'CVV',placeholder:'CVV'}},styleSniffer:'false',customCss:{display:'block',width:'100%',height:'44px',border:'0',padding:'0 12px','font-size':'16px','font-family':'Arial','box-sizing':'border-box',outline:'none'},callback:pay});button.disabled=false;calculate()};script.onerror=()=>showError('Secure payment fields could not load. Refresh and try again.');document.head.appendChild(script)}).catch(error=>showError(error.message));
  button.addEventListener('click',event=>{if(!form.reportValidity()){event.preventDefault();event.stopImmediatePropagation()}},true);
}

function initUpsell(){
  const accept=document.querySelector('[data-accept]'),skip=document.querySelector('[data-skip]'),product=document.body.dataset.product,next=document.body.dataset.next;
  const video=document.querySelector('.offer-video');
  if(video) Object.assign(video.style,{display:'block',width:'100%',maxWidth:'720px',aspectRatio:'16 / 9',background:'#111a3a',margin:'24px auto',objectFit:'contain'});
  accept.addEventListener('click',async()=>{if(accept.disabled)return;accept.disabled=true;const label=accept.textContent;accept.textContent='SECURELY PROCESSING…';try{const response=await fetch('/api/purchase',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({product})}),data=await response.json();if(!response.ok)throw Error(data.error||'Upgrade could not be completed');location.href=data.next+passParams()}catch(error){accept.disabled=false;accept.textContent=label;alert(error.message)}});
  skip.addEventListener('click',event=>{event.preventDefault();location.href=next+passParams()});
}

if(document.body.dataset.page==='checkout')initCheckout();
if(document.body.dataset.page==='upsell')initUpsell();

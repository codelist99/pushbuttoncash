const qs=new URLSearchParams(location.search);
const passParams=()=>qs.toString()?`?${qs.toString()}`:'';
const money=n=>`$${n.toFixed(2)}`;

function initCheckout(){
  const boxes=[...document.querySelectorAll('[data-addon]')];
  const total=document.querySelector('[data-total]');
  const rows=document.querySelector('[data-order-items]');
  const calculate=()=>{
    let amount=67;
    let html='<div class="product"><span>Push Button System</span><strong>$67.00</strong></div>';
    boxes.forEach(box=>{if(box.checked){const price=Number(box.dataset.price);amount+=price;html+=`<div class="product"><span>${box.dataset.title}</span><strong>${money(price)}</strong></div>`}});
    total.textContent=money(amount);rows.innerHTML=html;
  };
  boxes.forEach(box=>box.addEventListener('change',calculate));calculate();
  document.querySelector('[data-live-checkout]').addEventListener('click',()=>{
    const tid=qs.get('_ef_transaction_id')||'';
    const base='https://www.fanbasis.com/agency-checkout/accufy2/o2GYY/';
    location.href=base+(tid?encodeURIComponent(tid):'')+passParams();
  });
}

function initUpsell(){
  document.querySelector('[data-accept]').addEventListener('click',()=>location.href=document.body.dataset.next+passParams());
  document.querySelector('[data-skip]').addEventListener('click',e=>{e.preventDefault();location.href=document.body.dataset.next+passParams()});
}

if(document.body.dataset.page==='checkout')initCheckout();
if(document.body.dataset.page==='upsell')initUpsell();

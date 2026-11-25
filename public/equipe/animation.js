/* Scene animation uses the original artwork as masked layers, retaining the approved style. */
(()=>{
 const scene=document.querySelector('#scene'),NS='http://www.w3.org/2000/svg';
 const svg=document.createElementNS(NS,'svg');svg.setAttribute('viewBox','0 0 1448 1086');svg.setAttribute('aria-hidden','true');svg.classList.add('work-animation');
 const image=(clip,id='')=>`<image ${id?`id="${id}"`:''} href="/equipe/shop-clean.webp" width="1448" height="1086" clip-path="url(#${clip})"/>`;
 svg.innerHTML=`<defs>
 <clipPath id="clear-manager"><path d="M655 187H775V456H638V381H655Z"/></clipPath>
 <clipPath id="manager-body"><path d="M670 246L667 222L677 211L690 205L701 201L714 204L725 199L725 207L738 209L730 217L740 225L733 236L739 243L730 249L728 273L738 278L752 279L757 286L764 287L757 316L750 324L742 324L735 333L734 378L720 387L679 383L677 336L667 325L663 313L668 291L677 279L680 269L674 262Z"/></clipPath>
 <clipPath id="manager-leg-left"><path d="M678 380L700 382L697 408L696 432L689 439L675 435L672 425Z"/></clipPath>
 <clipPath id="manager-leg-right"><path d="M705 383L727 380L729 410L740 414L739 422L724 427L704 423L701 411Z"/></clipPath>
 <clipPath id="traffic-hand-left"><path d="M339 329L350 327L368 334L369 343L358 345L340 338Z"/></clipPath>
 <clipPath id="traffic-hand-right"><path d="M357 345L382 345L408 346L416 350L414 359L378 362L360 356Z"/></clipPath>
 <clipPath id="sales-hand-left"><path d="M577 567L592 565L607 576L604 585L590 586L578 578Z"/></clipPath>
 <clipPath id="sales-hand-right"><path d="M598 576L611 578L633 579L645 579L645 589L633 594L604 590L596 585Z"/></clipPath>
 <clipPath id="florist-arm-left"><path d="M1049 665L1061 667L1074 675L1098 680L1107 686L1104 696L1091 696L1055 682L1047 675Z"/></clipPath>
 <clipPath id="florist-arm-right"><path d="M1111 642L1121 648L1132 660L1128 670L1118 667L1107 655Z"/></clipPath>
 </defs>
 <image href="/equipe/shop-manager-empty.webp" width="1448" height="1086" clip-path="url(#clear-manager)"/>
 <g class="typing-a">${image('traffic-hand-left')}</g><g class="typing-b">${image('traffic-hand-right')}</g>
 <g class="typing-b sales-typing">${image('sales-hand-left')}</g><g class="typing-a sales-typing">${image('sales-hand-right')}</g>
 <g class="bouquet-left">${image('florist-arm-left')}</g><g class="bouquet-right">${image('florist-arm-right')}</g>
 <g class="camera-flash"><circle cx="932" cy="284" r="17" fill="#fff7cb" opacity=".3"/><path d="M932 266L935 280L947 284L935 287L932 301L929 287L917 284L929 280Z" fill="#fffbea"/><circle cx="932" cy="284" r="4" fill="white"/></g>
 <g id="manager-moving"><ellipse cx="0" cy="-7" rx="39" ry="13" fill="#684726" opacity=".17"/><g id="manager-walk-pose"><g transform="translate(-700 -435)"><g id="manager-left-foot">${image('manager-leg-left')}</g><g id="manager-right-foot">${image('manager-leg-right')}</g><g id="manager-upper">${image('manager-body')}</g></g></g></g>`;
 scene.insertBefore(svg,scene.querySelector('.shop-sign'));
 const moving=svg.querySelector('#manager-moving'),pose=svg.querySelector('#manager-walk-pose'),left=svg.querySelector('#manager-left-foot'),right=svg.querySelector('#manager-right-foot'),upper=svg.querySelector('#manager-upper');
 const button=scene.querySelector('[data-person="manager"]');
 // Coordinates describe open floor, with pauses beside each work area.
 const stops=[{x:0,y:0,wait:3},{x:-175,y:0,wait:3},{x:65,y:55,wait:3},{x:125,y:160,wait:3},{x:235,y:225,wait:4},{x:100,y:95,wait:1}];
 const travel=4;const duration=stops.reduce((n,p)=>n+p.wait+travel,0);
 let time=0,last=null,paused=matchMedia('(prefers-reduced-motion: reduce)').matches;
 function draw(t){let pos=t%duration;let start=stops[0],end=start,ratio=0,walking=false;for(let i=0;i<stops.length;i++){start=stops[i];end=stops[(i+1)%stops.length];if(pos<start.wait){end=start;break}pos-=start.wait;if(pos<travel){ratio=pos/travel;walking=true;break}pos-=travel}const x=start.x+(end.x-start.x)*ratio,y=start.y+(end.y-start.y)*ratio;const step=walking?Math.sin(t*12):0;moving.setAttribute('transform',`translate(${700+x} ${435+y})`);pose.setAttribute('transform',`translate(0 ${-Math.abs(step)*2}) scale(${walking&&end.x<start.x?-1:1} 1)`);left.setAttribute('transform',`translate(${step*1.5} ${step*3.5})`);right.setAttribute('transform',`translate(${-step*1.5} ${-step*3.5})`);upper.setAttribute('transform',`rotate(${walking?step*.6:Math.sin(t)*.3} 700 380)`);button.style.left=((630+x)/1448*100)+'%';button.style.top=((157+y)/1086*100)+'%';button.style.width='11%';button.style.height='27%';}
 function tick(now){if(last!==null&&!paused&&!document.hidden&&!scene.closest('.workspace').hidden)time+=Math.min((now-last)/1000,.05);last=now;draw(time);requestAnimationFrame(tick)}
 const control=document.querySelector('#motion');function setPaused(p){paused=p;scene.classList.toggle('animation-paused',p);control.textContent=p?'Retomar movimentos':'Pausar movimentos';control.setAttribute('aria-pressed',String(p));}
 control.onclick=()=>setPaused(!paused);setPaused(paused);draw(0);requestAnimationFrame(tick);
 document.addEventListener('visibilitychange',()=>{last=null});
})();

/* Переводы интерфейса: движок. Словари — i18n/<язык>.js, грузится только выбранный. Исходные строки — русские. */
(function(){
var LANGS=[['ru','Русский'],['uk','Українська'],['en','English'],['fr','Français'],['es','Español'],['it','Italiano'],['uz',"O'zbekcha"],['tr','Türkçe'],['zh','中文'],['ja','日本語'],['ko','한국어']];
var LOCALE={ru:'ru-RU',uk:'uk-UA',en:'en-GB',fr:'fr-FR',es:'es-ES',it:'it-IT',uz:'uz-Latn-UZ',tr:'tr-TR',zh:'zh-CN',ja:'ja-JP',ko:'ko-KR'};
var UNITS={ // после цифр
 кг:{uk:'кг',en:'kg',fr:'kg',es:'kg',it:'kg',uz:'kg',tr:'kg',zh:'公斤',ja:'kg',ko:'kg'},
 ккал:{uk:'ккал',en:'kcal',fr:'kcal',es:'kcal',it:'kcal',uz:'kkal',tr:'kcal',zh:'千卡',ja:'kcal',ko:'kcal'},
 мин:{uk:'хв',en:'min',fr:'min',es:'min',it:'min',uz:'daq',tr:'dk',zh:'分钟',ja:'分',ko:'분'},
 сек:{uk:'сек',en:'sec',fr:'s',es:'s',it:'s',uz:'son',tr:'sn',zh:'秒',ja:'秒',ko:'초'},
 г:{uk:'г',en:'g',fr:'g',es:'g',it:'g',uz:'g',tr:'g',zh:'克',ja:'g',ko:'g'},
 мл:{uk:'мл',en:'ml',fr:'ml',es:'ml',it:'ml',uz:'ml',tr:'ml',zh:'毫升',ja:'ml',ko:'ml'},
 см:{uk:'см',en:'cm',fr:'cm',es:'cm',it:'cm',uz:'sm',tr:'cm',zh:'厘米',ja:'cm',ko:'cm'},
 км:{uk:'км',en:'km',fr:'km',es:'km',it:'km',uz:'km',tr:'km',zh:'公里',ja:'km',ko:'km'},
 ч:{uk:'год',en:'h',fr:'h',es:'h',it:'h',uz:'soat',tr:'sa',zh:'小时',ja:'時間',ko:'시간'},
 лет:{uk:'р.',en:'y.o.',fr:'ans',es:'años',it:'anni',uz:'yosh',tr:'yaş',zh:'岁',ja:'歳',ko:'세'},
 'повт.':{uk:'повт.',en:'reps',fr:'rép.',es:'rep.',it:'rip.',uz:'takror',tr:'tekrar',zh:'次',ja:'回',ko:'회'},
 тренировок:{uk:'тренувань',en:'workouts',fr:'séances',es:'entrenos',it:'allenamenti',uz:'mashgʻulot',tr:'antrenman',zh:'次训练',ja:'回',ko:'회'},
 тренировки:{uk:'тренування',en:'workouts',fr:'séances',es:'entrenos',it:'allenamenti',uz:'mashgʻulot',tr:'antrenman',zh:'次训练',ja:'回',ko:'회'},
 тренировка:{uk:'тренування',en:'workout',fr:'séance',es:'entreno',it:'allenamento',uz:'mashgʻulot',tr:'antrenman',zh:'次训练',ja:'回',ko:'회'},
 упражнений:{uk:'вправ',en:'exercises',fr:'exercices',es:'ejercicios',it:'esercizi',uz:'mashq',tr:'egzersiz',zh:'个动作',ja:'種目',ko:'종목'},
 измерений:{uk:'вимірювань',en:'entries',fr:'mesures',es:'registros',it:'misurazioni',uz:'oʻlchov',tr:'ölçüm',zh:'次测量',ja:'回',ko:'회'},
 'км/ч':{uk:'км/год',en:'km/h',fr:'km/h',es:'km/h',it:'km/h',uz:'km/soat',tr:'km/sa',zh:'公里/小时',ja:'km/h',ko:'km/h'},
 м:{uk:'м',en:'m',fr:'m',es:'m',it:'m',uz:'m',tr:'m',zh:'米',ja:'m',ko:'m'},
 с:{uk:'с',en:'s',fr:'s',es:'s',it:'s',uz:'s',tr:'sn',zh:'秒',ja:'秒',ko:'초'},
 из:{uk:'з',en:'of',fr:'sur',es:'de',it:'di',uz:'/',tr:'/',zh:'/',ja:'/',ko:'/'}
};
var MACRO={Б:{en:'P',fr:'P',es:'P',it:'P',uz:'O',tr:'P',zh:'蛋白',ja:'P',ko:'단'},Ж:{en:'F',fr:'L',es:'G',it:'G',uz:'Y',tr:'Y',zh:'脂',ja:'F',ko:'지'},У:{en:'C',fr:'G',es:'C',it:'C',uz:'U',tr:'K',zh:'碳',ja:'C',ko:'탄'}};
var SKIP='input,textarea,script,style,[data-no-tr],#authLog';
var PRE_ZA={uk:'за',en:'over',fr:'sur',es:'en',it:'in',uz:'',tr:'',zh:'',ja:'',ko:''};
var SKIPA='script,style,[data-no-tr],#authLog';
var CYR=/[А-Яа-яЁёІіЇїЄєҐґ]/;
var DICTS=window.GD_I18N_LANG=window.GD_I18N_LANG||{}, VER='20260927', chosen=false, built='';
var TPL=[];
var lang='ru', map=null, rx=null, urx=null, mrx=null, orig=new WeakMap(), obs=null;

function pick(){
  try{var s=localStorage.getItem('gd_lang'); if(s && LOCALE[s]){ chosen=true; return s; }}catch(e){}
  var c='';
  try{c=(window.Telegram&&Telegram.WebApp&&Telegram.WebApp.initDataUnsafe&&Telegram.WebApp.initDataUnsafe.user&&Telegram.WebApp.initDataUnsafe.user.language_code)||'';}catch(e){}
  c=(c||navigator.language||'ru').toLowerCase().split(/[-_]/)[0];
  if(LOCALE[c]) return c;
  if(['be','kk','ky','tg','hy','az','ka','tt','ba'].indexOf(c)>=0) return 'ru';
  return 'en';
}
function esc(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
// словарь языка лежит в i18n/<код>.js и подгружается только для выбранного языка
function load(l, cb){
  if(l==='ru' || DICTS[l]){ cb(); return; }
  var sc=document.createElement('script'); sc.src='i18n/'+l+'.js?v='+VER; sc.onload=cb; sc.onerror=cb; document.head.appendChild(sc);
}
function build(){
  map=null; rx=urx=mrx=null; built=lang;
  if(lang==='ru') return;
  map=Object.create(null);
  var d=DICTS[lang]||{}, k;
  TPL=[];
  for(k in d){ map[k]=d[k];
    // шаблоны с числами {1}… и словами {a}/{b}: «1. Базовый обмен — {1} ккал.»
    if(/\{(\d|[ab])\}/.test(k)){ var names=[];
      var src='^'+k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\\\{(\d|[ab])\\\}/g,function(m,n){ names.push(n); return /\d/.test(n)?'([−+]?\\s?[\\d\\s.,:]+?)':'([А-Яа-яЁё]+)'; })+'$';
      try{ TPL.push({re:new RegExp(src), names:names, t:d[k]}); }catch(e){} } }
  var keys=Object.keys(map).filter(function(k){return (k.length>=4 && !/^\d/.test(k) && !/\{/.test(k)) || /^[А-ЯЁ][а-яё]$/.test(k);}).sort(function(a,b){return b.length-a.length;});
  var ul=Object.keys(UNITS).filter(function(u){return UNITS[u][lang];}).sort(function(a,b){return b.length-a.length;});
  try{
    rx=new RegExp('(?<![А-Яа-яЁё])('+keys.map(esc).join('|')+')(?![А-Яа-яЁё])','g');
    urx=new RegExp('(\\d)(\\s?)('+ul.map(esc).join('|')+')(?![А-Яа-яЁё])','g');
    mrx=/(^|\s|·\s)([БЖУ]) (?=\d)/g;
  }catch(e){ rx=urx=mrx=null; } // старые WebView без lookbehind — только точные совпадения
}
function tr(s){
  if(built!==lang || (lang!=='ru' && !map && DICTS[lang])) build();
  if(!map || !s || !CYR.test(s)) return s;
  var t=s.trim();
  if(map[t]!==undefined) return s.replace(t,map[t]);
  if(t.slice(0,2)==='+ ' && map[t.slice(2)]!==undefined) return s.replace(t,'+ '+map[t.slice(2)]);
  for(var i=0;i<TPL.length;i++){ var m=TPL[i].re.exec(t); if(!m) continue;
    var tp=TPL[i], res=tp.t; tp.names.forEach(function(n,j){ var v=m[j+1]; if(!/\d/.test(n) && map[v]!==undefined) v=map[v]; res=res.split('{'+n+'}').join(v); });
    return s.replace(t,res); }
  var out=s;
  if(rx) out=out.replace(rx,function(m){return map[m];});
  if(urx) out=out.replace(urx,function(m,d,sp,u){return d+sp+UNITS[u][lang];});
  if(mrx) out=out.replace(mrx,function(m,p,l){return p+(MACRO[l][lang]||l)+' ';});
  out=out.replace(/(^|\s)(из|за)(?= \d)/g,function(m,p,w){return p+(w==='из'?UNITS['из'][lang]:(PRE_ZA[lang]||w));});
  out=out.replace(/(^|\s)(пн|вт|ср|чт|пт|сб|вс)(?= \d)/g,function(m,p,w){return p+(map[w]||w);});
  var left=out.match(/[А-Яа-яЁё]{2,}/g);
  if(left && left.length>=3) return s; // длинная фраза без полного перевода — оставляем целиком по-русски, без мешанины
  return out;
}
function skip(el){ return el && el.closest && el.closest(SKIP); }
function doText(n){
  var p=n.parentElement; if(!p || skip(p)) return;
  var o=orig.get(n), cur=n.nodeValue;
  if(!o || o.t!==cur) o={s:cur,t:cur};
  var r=lang==='ru'?o.s:tr(o.s);
  o.t=r; orig.set(n,o);
  if(r!==cur) n.nodeValue=r;
}
var ATTR=['placeholder','title','aria-label','alt'];
function doEl(el){
  if(el.closest && el.closest(SKIPA)) return;
  for(var i=0;i<ATTR.length;i++){
    var a=ATTR[i], v=el.getAttribute(a); if(v==null) continue;
    var key='data-tr-'+a, src=el.getAttribute(key), last=el.getAttribute(key+'-t');
    if(src==null || last!==v){ src=v; el.setAttribute(key,src); }
    var r=lang==='ru'?src:tr(src);
    el.setAttribute(key+'-t',r);
    if(r!==v) el.setAttribute(a,r);
  }
}
function walk(root){
  if(!root) return;
  if(root.nodeType===3){ doText(root); return; }
  if(root.nodeType!==1) return;
  doEl(root);
  if(skip(root)) return;
  var w=document.createTreeWalker(root,5,null), n;
  while((n=w.nextNode())){ if(n.nodeType===3) doText(n); else doEl(n); }
}
function start(){
  if(obs) return;
  obs=new MutationObserver(function(ms){
    if(lang==='ru' && !document.documentElement.hasAttribute('data-tr-was')) return;
    obs.disconnect();
    for(var i=0;i<ms.length;i++){
      var m=ms[i];
      if(m.type==='characterData') doText(m.target);
      else if(m.type==='attributes') doEl(m.target);
      else for(var j=0;j<m.addedNodes.length;j++) walk(m.addedNodes[j]);
    }
    observe();
  });
  observe();
  walk(document.body);
}
function observe(){ obs.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:ATTR}); }
function set(l, auto){
  if(!LOCALE[l]) return;
  if(!auto){ try{localStorage.setItem('gd_lang',l);}catch(e){} chosen=true; I18N.chosen=true; }
  load(l, function(){
    if(l!=='ru') document.documentElement.setAttribute('data-tr-was','1');
    lang=l; I18N.lang=l; I18N.locale=LOCALE[l]; document.documentElement.lang=l; build();
    if(obs){ obs.disconnect(); walk(document.body); observe(); }
    try{ if(typeof renderMain==='function') renderMain(); if(typeof renderModal==='function' && window.State && State.modal) renderModal(); }catch(e){}
    try{ window.dispatchEvent(new CustomEvent('gd-lang',{detail:l})); }catch(e){}
  });
}
lang=pick();
// словарь нужен до первой отрисовки: пока страница грузится, вставляем его скрипт сразу за этим
if(lang!=='ru' && !DICTS[lang] && document.readyState==='loading') document.write('<script src="i18n/'+lang+'.js?v='+VER+'"><\/script>');
else if(lang!=='ru') load(lang, function(){ build(); if(obs){ obs.disconnect(); walk(document.body); observe(); } });
if(lang!=='ru') document.documentElement.setAttribute('data-tr-was','1');
window.I18N={LANGS:LANGS,lang:lang,locale:LOCALE[lang],t:tr,set:set,chosen:chosen,
  select:function(){return '<select id="langSel" data-no-tr>'+LANGS.map(function(x){return '<option value="'+x[0]+'"'+(x[0]===lang?' selected':'')+'>'+x[1]+'</option>';}).join('')+'</select>';}};
document.documentElement.lang=lang;
document.addEventListener('change',function(e){ if(e.target && e.target.id==='langSel') set(e.target.value); });
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',start); else start();
})();

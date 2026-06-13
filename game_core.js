/* ============================================================
 Bomb Busters — shared game core（ソロ/オンライン共通・単一ソース）
 ブラウザ(ソロ)・Node(テスト)・Cloudflare Worker(オンライン) 共用。
 - ブラウザ: 実DOMを使用。UI層(render/tileHTML/useEquip等)は
   このファイルの後に読み込んだスクリプトで上書きできる。
 - ヘッドレス: DOM/localStorageスタブ、タイマーは無効(no-op)。
 ルール変更は必ずこのファイルだけを編集すること。
 ============================================================ */
var IS_BROWSER = (typeof window !== 'undefined' && !!window.document);
var __inputs = {};
function __mkEl(id){
  return {
    get value(){ return __inputs[id] || ''; },
    set value(v){ __inputs[id] = v; },
    className:'', style:{},
    set innerHTML(v){}, get innerHTML(){ return ''; },
    set textContent(v){}, set onclick(v){},
    appendChild(){}, insertAdjacentHTML(){},
    classList:{ add(){}, remove(){}, contains(){ return false; } },
    get firstChild(){ return __mkEl(id); },
    querySelectorAll(){ return []; }
  };
}
if (!IS_BROWSER) {
  globalThis.document = { getElementById: function(id){ return __mkEl(id); }, createElement: function(){ return __mkEl(); } };
  globalThis.localStorage = { getItem: function(){ return null; }, setItem: function(){}, removeItem: function(){} };
}
var __nativeAlert = IS_BROWSER ? window.alert.bind(window) : null;
var setTimeout = IS_BROWSER ? window.setTimeout.bind(window) : function(){};
var alert   = IS_BROWSER ? function(m){ if (window.uiToast) window.uiToast(m); else __nativeAlert(m); } : function(){};
var confirm = IS_BROWSER ? window.confirm.bind(window) : function(){ return false; };
var prompt  = IS_BROWSER ? window.prompt.bind(window)  : function(){ return null; };

/* ===== begin client game logic (verbatim) ===== */

let S=null;
const VN=['ケン','アオイ','ユメ','リク'];
const EQUIP={1:{name:'コトナルラベル',kind:'kotonal'},2:{name:'イレカエシーバー',kind:'swap'},3:{name:'ミッツケル探知機',kind:'mitsu'},4:{name:'ヒント付箋',kind:'reveal'},5:{name:'スーパー探知機',kind:'super'},6:{name:'失敗帳消し機',kind:'life'},7:{name:'非常電池',kind:'battery'},8:{name:'なんでもレーダー',kind:'radar'},9:{name:'万能氷',kind:'ice'},10:{name:'ドッチカアタ・レイ',kind:'dochi'},11:{name:'いつでもコーヒー',kind:'extra'},12:{name:'イコールラベル',kind:'equal'},13:{name:'ヒミツ底',kind:'himitsu'}};
const DETCFG={free:{tiles:2,decls:1,yellow:false,name:'フツー探知機',sel:'2本'},mitsu:{tiles:3,decls:1,yellow:false,name:'ミッツケル探知機',sel:'3本'},dochi:{tiles:1,decls:2,yellow:true,name:'ドッチカアタ・レイ',sel:'1本'}};
const MISSIONS={'4':{reds:1,yellows:2,name:'#4 実地訓練1日目'},'8':{reds:1,yellows:2,name:'#8 最終試験'},'9':{reds:1,yellows:2,name:'#9 優先順位の判断'},'11':{reds:0,yellows:2,name:'#11 赤のような青'},'16':{reds:1,yellows:2,name:'#16 つじつまは合っている'},'20':{reds:1,yellows:2,name:'#20 悪い狼'}};
function g(id){return document.getElementById(id);}
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function pick(a,k){return shuffle(a.slice()).slice(0,k);}
function ri(a,b){return a+Math.floor(Math.random()*(b-a+1));}
function findTile(pred){for(const p of S.players)for(const t of p.tiles)if(pred(t))return t;return null;}
function deal(){
  const myName=(g('myName').value||'りょうま').trim();
  var aiStyleSel=(g('aiStyle')&&g('aiStyle').value)||'std';
  const msel=g('mission').value;var N=Math.max(4,Math.min(5,parseInt(g('pcount').value)||4));let R,Y,mname;
  if(msel==='R'){R=ri(4,7);Y=ri(2,4);mname='ランダム';}else{R=MISSIONS[msel].reds;Y=MISSIONS[msel].yellows;mname=MISSIONS[msel].name;}
  let deck=[];
  for(let n=1;n<=12;n++)for(let c=0;c<4;c++)deck.push({t:'B',n,val:n});
  pick([1,2,3,4,5,6,7,8,9,10,11],R).forEach(n=>deck.push({t:'R',n,val:n+0.5}));
  pick([1,2,3,4,5,6,7,8,9,10,11],Y).forEach(n=>deck.push({t:'Y',n,val:n+0.1}));
  shuffle(deck);
  const players=[myName].concat(VN.slice(0,N-1)).map((nm,i)=>({name:nm,isYou:i===0,tiles:[],detector:true}));
  deck.forEach((t,i)=>players[i%N].tiles.push(Object.assign({cut:false,revealed:false,done:false},t)));
  players.forEach(p=>p.tiles.sort((a,b)=>a.val-b.val));
  // #11: a drawn number's 4 codes become RED (cutting one = explosion). Convert blues->red.
  var dangerNum=null;
  if(msel==='11'){ dangerNum=ri(1,12);
    players.forEach(function(p){p.tiles.forEach(function(t){ if(t.t==='B'&&t.n===dangerNum){ t.t='R'; t.danger=true; } });});
  }
  // #20: each player's last-dealt code goes to the RIGHT END, out of value order, marked X.
  // It breaks position-deduction and is ignored by / cannot be targeted by any equipment & the detector.
  if(msel==='20'){
    players.forEach(function(p){ if(!p.tiles.length)return;
      var xi=Math.floor(Math.random()*p.tiles.length); var x=p.tiles.splice(xi,1)[0]; x.xcode=true; p.tiles.push(x); });
  }
  // start info token: each player reveals 1 NON-RED tile (赤には情報トークンを置けない)
  // info tokens are placed one-by-one in turn order during runInfoPhase()
  var redUncertain=false,redCandidates=null,yellowUncertain=false,yellowCandidates=null;
  if(msel==='8'){
    var rt=null;players.forEach(p=>p.tiles.forEach(t=>{if(t.t==='R')rt=t;}));
    if(rt){var realGap=Math.floor(rt.val);var others=[1,2,3,4,5,6,7,8,9,10,11].filter(x=>x!==realGap);var decoy=others[Math.floor(Math.random()*others.length)];redCandidates=shuffle([realGap,decoy]);redUncertain=true;}
    var yg=[];players.forEach(p=>p.tiles.forEach(t=>{if(t.t==='Y')yg.push(Math.floor(t.val));}));
    if(yg.length){var oth2=[1,2,3,4,5,6,7,8,9,10,11].filter(x=>yg.indexOf(x)<0);var dec2=oth2[Math.floor(Math.random()*oth2.length)];yellowCandidates=shuffle(yg.concat([dec2]));yellowUncertain=true;}
  }
  const en=N;
  var _mnum=parseInt(msel); var _ge9=(!isNaN(_mnum)&&_mnum>=9);
  var eqPool=_ge9?[1,2,3,4,5,6,7,8,9,10,11,12,13]:[1,2,3,4,5,6,7,8,9,10,11,12];
  if(dangerNum) eqPool=eqPool.filter(function(x){return x!==dangerNum;});
  const equip=pick(eqPool,en).map(id=>({id,name:EQUIP[id].name,kind:EQUIP[id].kind,used:false,num:id}));
  equip.sort((a,b)=>a.num-b.num);
  var prio=null;if(msel==='9'){prio={nums:pick([1,2,3,4,5,6,7,8,9,10,11,12],3),ptr:0,thr:2};}else if(msel==='16'){prio={nums:pick([1,2,3,4,5,6,7,8,9,10,11,12],3),ptr:0,thr:4};}
  var skill=0;try{skill=parseInt(localStorage.getItem('bb_skill'))||0;}catch(e){}
  var _ord=[];for(var _z=0;_z<N;_z++)_ord.push(_z);var order=shuffle(_ord);var captain=order[0];
  S={players,reds:R,yellows:Y,lives:N,maxLives:N,turn:0,cut:{},yCut:0,redDone:0,over:null,sel:null,pick:null,extra:false,passStreak:0,holds:{},equip,mission:mname,prio:prio,skill:skill,aiStyle:aiStyleSel,_scored:false,redUncertain:redUncertain,redCandidates:redCandidates,yellowUncertain:yellowUncertain,yellowCandidates:yellowCandidates,dangerNum:dangerNum,detMode:false,detSel:[],detKind:'free',detEquipIdx:-1,detDecls:[],detPick:null,infoPlace:null,ownSel:null,labelMode:false,labelSel:[],labelKind:null,labelEquipIdx:-1,swapMode:false,swapTarget:-1,swapEquipIdx:-1,iceShield:false,pickInfo:false,captain:captain,order:order,infoPhase:true,infoIdx:0,log:[]};
  pushLog('['+mname+'] 配り完了。赤'+R+'・黄'+Y+'を含む'+(48+R+Y)+'枚を'+N+'卓へ。装備'+en+'枚。各自1枚公開。');
  pushLog('AIレベル Lv.'+skill+'（プレイを重ねるほど賢くなります）。'+(redUncertain?' #8：赤は「？2カ所」のどちらか1本、黄は「？3カ所」のいずれか2本。':''));
  pushLog('👑 隊長（親）は <b>'+players[captain].name+'</b>。手番順：'+order.map(function(i){return players[i].name;}).join(' → ')+'。');
  if(prio){var _need=(prio.thr||2);pushLog('🔢 優先順位：'+prio.nums.map(function(x,i){return String.fromCharCode(97+i)+'='+x;}).join(' → ')+'。a→b→cの順に各'+_need+'本切るごとに次が解禁。順番外の数字は切れません。');}
  if(dangerNum)pushLog('☠ #11：数字 <b>'+dangerNum+'</b> の4本のコードは赤と同じ扱い。切ると即爆発・失敗。切らずに処理すること。','bad');
  if(msel==='20')pushLog('🐺 #20：各プレイヤーの右端に「✕」コードがあります。数値順に並んでおらず、探知機・装備の対象にできません（通常の宣言での切断は可能）。','bad');
  g('setupCard').classList.add('hidden');g('board').classList.remove('hidden');render();saveGame();runInfoPhase();
}
function cutBlue(n){return S.cut[n]||0;}
function activeNonRed(){let c=0;S.players.forEach(p=>p.tiles.forEach(t=>{if(!t.cut&&t.t!=='R')c++;}));return c;}
function activeRedUndone(){let c=0;S.players.forEach(p=>p.tiles.forEach(t=>{if(t.t==='R'&&!t.done)c++;}));return c;}
function pushLog(s,cls){S.log.unshift('<div class="'+(cls||'')+'">'+s+'</div>');}
function recomputeCuts(){S.cut={};S.players.forEach(p=>p.tiles.forEach(t=>{if(t.t==='B'&&t.cut)S.cut[t.n]=(S.cut[t.n]||0)+1;}));advancePrio();}
function prioLocked(n){if(!S.prio)return false;var idx=S.prio.nums.indexOf(n);return idx>S.prio.ptr;}
function advancePrio(){if(!S.prio)return;var thr=S.prio.thr||2;while(S.prio.ptr<S.prio.nums.length&&cutBlue(S.prio.nums[S.prio.ptr])>=thr)S.prio.ptr++;}
function prioCanAct(pi){if(!S.prio)return true;var act=S.players[pi].tiles.filter(function(t){return !t.cut&&!t.done;});if(act.length===0)return true;var freeBlue=act.some(function(t){return t.t==='B'&&!prioLocked(t.n);});var hasY=act.some(function(t){return t.t==='Y';});var allRed=act.every(function(t){return t.t==='R';});return freeBlue||hasY||allRed;}
function bumpSkill(){if(S._scored)return;S._scored=true;S.skill=(S.skill||0)+1;try{localStorage.setItem('bb_skill',S.skill);}catch(e){}pushLog('AIがこの卓で経験を積んだ → 次回からAI Lv.'+S.skill+'。');}
function checkEnd(){if(S.lives<=0){S.over='lose';pushLog('起爆ダイヤルが限界。爆発…失敗。','bad');bumpSkill();return;}if(activeNonRed()===0&&activeRedUndone()===0){S.over='win';pushLog('すべて処理完了！爆弾解除成功！','ok');bumpSkill();}}
function ownActive(p){return p.tiles.map((t,i)=>({t,i})).filter(o=>!o.t.cut&&!o.t.done);}
function publicRevealedTiles(except){let r=[];S.players.forEach((p,pi)=>{if(pi===except)return;p.tiles.forEach((t,i)=>{if(t.revealed&&!t.cut&&!t.done)r.push({pi,i,t});});});return r;}
function knownVal(t){return t.t==='B'?t.n:(t.t==='Y'?t.n+0.1:t.n+0.5);}
function mateList(){var a=[];for(var i=1;i<S.players.length;i++)a.push(i+'='+S.players[i].name);return a.join(' / ');}
function isMate(i){return i>=1&&i<S.players.length;}
function L(i){return String.fromCharCode(65+i);}
/* ===== 宣言履歴からの手札推理 =====
   宣言＝その数字を保有している証拠（公開情報）。S.holdsに記録し、
   その保有分が公開の場で切断されたら消し込む。AIの確率計算で利用。 */
function noteHold(pi,n){if(typeof n!=='number'||isNaN(n))return;S.holds=S.holds||{};(S.holds[pi]=S.holds[pi]||{})[n]=true;}
function clearHold(pi,n){if(S.holds&&S.holds[pi])delete S.holds[pi][n];}
function holdFitCount(p2,h){var c=0,P=S.players[p2];for(var i=0;i<P.tiles.length;i++){var t=P.tiles[i];if(t.cut||t.done||t.revealed)continue;var rg=tileRange(p2,i);if(h>=rg.lo&&h<=rg.hi)c++;}return c;}
function tileRange(pi,i){var P=S.players[pi];if(P.tiles[i]&&P.tiles[i].xcode)return {lo:1,hi:12};var leftV=0,rightV=13;for(var k=i-1;k>=0;k--){var t=P.tiles[k];if(t.xcode)continue;if(t.revealed||t.cut||t.done){leftV=knownVal(t);break;}}for(var k2=i+1;k2<P.tiles.length;k2++){var t2=P.tiles[k2];if(t2.xcode)continue;if(t2.revealed||t2.cut||t2.done){rightV=knownVal(t2);break;}}return {lo:Math.max(1,Math.ceil(leftV)),hi:Math.min(12,Math.floor(rightV))};}
function hiddenRem(n){var rev=0;S.players.forEach(function(p){p.tiles.forEach(function(t){if(t.t==='B'&&t.n===n&&t.revealed&&!t.cut&&!t.done)rev++;});});return Math.max(0,4-cutBlue(n)-rev);}
function rawRange(pi,i){var P=S.players[pi];if(P.tiles[i]&&P.tiles[i].xcode)return {leftV:0,rightV:13};var leftV=0,rightV=13;for(var k=i-1;k>=0;k--){var t=P.tiles[k];if(t.xcode)continue;if(t.revealed||t.cut||t.done){leftV=knownVal(t);break;}}for(var k2=i+1;k2<P.tiles.length;k2++){var t2=P.tiles[k2];if(t2.xcode)continue;if(t2.revealed||t2.cut||t2.done){rightV=knownVal(t2);break;}}return {leftV:leftV,rightV:rightV};}
function remTypeIn(type,leftV,rightV){var c=0;S.players.forEach(function(p){p.tiles.forEach(function(t){if(t.t===type&&!t.cut&&!t.done&&t.val>leftV&&t.val<rightV)c++;});});return c;}
function activeCount(){var c=0;S.players.forEach(function(p){if(p.tiles.some(function(t){return !t.cut&&!t.done;}))c++;});return c;}
function yProb(p2,i){var P=S.players[p2];var rr=rawRange(p2,i);var lo=i;while(lo-1>=0&&!(P.tiles[lo-1].revealed||P.tiles[lo-1].cut||P.tiles[lo-1].done))lo--;var hi=i;while(hi+1<P.tiles.length&&!(P.tiles[hi+1].revealed||P.tiles[hi+1].cut||P.tiles[hi+1].done))hi++;var k=hi-lo+1,j=i-lo;var E=rr.leftV+(j+1)/(k+1)*(rr.rightV-rr.leftV);var wY=0,wR=0,wB=0;for(var n=1;n<=12;n++){if(n>=rr.leftV&&n<=rr.rightV){var c=hiddenRem(n);if(c>0)wB+=c/(1+Math.pow(n-E,2));}}S.players.forEach(function(p){p.tiles.forEach(function(t){if((t.t==='Y'||t.t==='R')&&!t.cut&&!t.done&&!t.revealed&&t.val>rr.leftV&&t.val<rr.rightV){var w=1/(1+Math.pow(t.val-E,2));if(t.t==='Y')wY+=w;else wR+=w;}});});var hs2=(S.holds&&S.holds[p2]);if(hs2){for(var hk2 in hs2){var h2=+hk2;if(!hs2[hk2])continue;if(h2>=rr.leftV&&h2<=rr.rightV&&hiddenRem(h2)>0){var f2=holdFitCount(p2,h2);if(f2>0)wB+=6.0/f2;}}}
var d=wY+wR+wB;if(d<=0)return {pY:0,pR:0};return {pY:wY/d,pR:wR/d};}
function buildDetector(pi,n){var me=S.players[pi];if(!me.detector)return null;if(!me.tiles.some(function(t){return t.t==='B'&&t.n===n&&!t.cut&&!t.done;}))return null;if(hiddenRem(n)<=0)return null;if(prioLocked(n))return null;function pn(rg){var d=0;for(var m=rg.lo;m<=rg.hi;m++)d+=hiddenRem(m);return d>0?hiddenRem(n)/d:0;}var best=null;S.players.forEach(function(p,p2){if(p2===pi)return;for(var i=0;i<p.tiles.length-1;i++){var a=p.tiles[i],b=p.tiles[i+1];if(a.xcode||b.xcode)continue;if(a.cut||a.done||a.revealed)continue;if(b.cut||b.done||b.revealed)continue;var ra=tileRange(p2,i),rb=tileRange(p2,i+1);var aIn=(n>=ra.lo&&n<=ra.hi),bIn=(n>=rb.lo&&n<=rb.hi);if(!aIn&&!bIn)continue;var pa=aIn?pn(ra):0,pb=bIn?pn(rb):0;var pc=1-(1-pa)*(1-pb);if(!best||pc>best.pc)best={p2:p2,i1:i,i2:i+1,pc:pc};}});if(!best)return null;return {kind:'detector',targetPi:best.p2,i1:best.i1,i2:best.i2,n:n,_pc:best.pc,text:'<span style="color:var(--green)">探知機</span>：'+me.name+'は探知機で '+S.players[best.p2].name+' の隣り合う2本（'+L(best.i1)+'・'+L(best.i2)+'）に「'+n+'」を宣言（赤でも爆発しない）。'};}
function tileDist(p2,i){var P=S.players[p2];var rr=rawRange(p2,i);
  var lo=i;while(lo-1>=0&&!(P.tiles[lo-1].revealed||P.tiles[lo-1].cut||P.tiles[lo-1].done))lo--;
  var hi=i;while(hi+1<P.tiles.length&&!(P.tiles[hi+1].revealed||P.tiles[hi+1].cut||P.tiles[hi+1].done))hi++;
  var k=hi-lo+1,j=i-lo;var Ev=rr.leftV+(j+1)/(k+1)*(rr.rightV-rr.leftV);
  var wB={},wY=0,wR=0,tot=0;
  for(var nn=1;nn<=12;nn++){if(nn>=rr.leftV&&nn<=rr.rightV){var c=hiddenRem(nn);if(c>0){var w=c/(1+Math.pow(nn-Ev,2));wB[nn]=w;tot+=w;}}}
  S.players.forEach(function(p){p.tiles.forEach(function(t){if((t.t==='Y'||t.t==='R')&&!t.cut&&!t.done&&!t.revealed&&t.val>rr.leftV&&t.val<rr.rightV){var w=1/(1+Math.pow(t.val-Ev,2));if(t.t==='Y'){wY+=w;}else{wR+=w;}tot+=w;}});});
  // 宣言履歴: この人が保有確定している数字は、入りうる位置に強い重みを足す
  var hs=(S.holds&&S.holds[p2]);
  if(hs){for(var hk in hs){var h=+hk;if(!hs[hk])continue;
    if(h>=rr.leftV&&h<=rr.rightV&&hiddenRem(h)>0){var fit=holdFitCount(p2,h);
      if(fit>0){var bw=6.0/fit;wB[h]=(wB[h]||0)+bw;tot+=bw;}}}}
  if(tot<=0)return {byNum:{},pY:0,pR:0};
  var byNum={};for(var key in wB)byNum[key]=wB[key]/tot;
  return {byNum:byNum,pY:wY/tot,pR:wR/tot};
}
function decideMove(pi){
  const me=S.players[pi];const mine=ownActive(me);
  for(let n=1;n<=12;n++){if(prioLocked(n))continue;const h=mine.filter(o=>o.t.t==='B'&&o.t.n===n).length;if(h>=2&&h===(4-cutBlue(n)))return{kind:'solo',n,text:'<span style="color:var(--green)">確実</span>：'+me.name+'は番号 <b>'+n+'</b> の残り'+h+'本を全部持っている → 単独で切る。'};}
  var myYc=mine.filter(function(o){return o.t.t==='Y';}).length;var totYc=0;S.players.forEach(function(p){p.tiles.forEach(function(t){if(t.t==='Y'&&!t.cut&&!t.done)totYc++;});});if(myYc>=2&&myYc===totYc)return{kind:'soloY',text:'<span style="color:var(--green)">確実</span>：'+me.name+'は残りの黄を全部持っている → 単独で切る。'};
  for(const r of publicRevealedTiles(pi)){
    if(r.t.t==='B'&&!prioLocked(r.t.n)&&mine.some(o=>o.t.t==='B'&&o.t.n===r.t.n))return{kind:'matchRev',n:r.t.n,target:r,text:'<span style="color:var(--green)">確実</span>：公開済みの '+S.players[r.pi].name+' の'+L(r.i)+'（'+r.t.n+'）と自分の'+r.t.n+'を切る。'};
    if(r.t.t==='Y'&&mine.some(o=>o.t.t==='Y'))return{kind:'matchRevY',target:r,text:'<span style="color:var(--green)">確実</span>：公開済みの '+S.players[r.pi].name+' の黄と自分の黄を切る。'};
  }
  // reveal-all-red ONLY when whole hand is red
  if(mine.length>0&&mine.every(o=>o.t.t==='R'))return{kind:'revealAllRed',text:me.name+'の手札は赤のみ → すべての赤を公開して処理する。'};
  var skill=S.skill||0;
  if(S.lives<=2){var li=S.equip.findIndex(function(e){return !e.used&&e.kind==='life'&&cutBlue(e.num)>=2;});if(li>=0)return{kind:'equipLife',ei:li,text:'<span style="color:var(--green)">装備</span>：'+me.name+'は残機が少ないので「'+S.equip[li].name+'」で残機回復。'};}
  var hidden=[];S.players.forEach(function(p,p2){if(p2===pi)return;p.tiles.forEach(function(t,i){if(!t.cut&&!t.done&&!t.revealed)hidden.push({pi:p2,i:i});});});
  var myNums=[...new Set(mine.filter(function(o){return o.t.t==='B'&&!prioLocked(o.t.n);}).map(function(o){return o.t.n;}))];
  var haveY=mine.some(function(o){return o.t.t==='Y';});
  // Risk-aware reads: each candidate tile gets a full identity distribution, so a
  // blue 2-person cut is weighed against the chance the tile is RED (=instant loss).
  var bg=null;
  hidden.forEach(function(o){var dist=tileDist(o.pi,o.i);myNums.forEach(function(n){var pn=dist.byNum[n]||0;if(pn<=0)return;if(!bg||pn>bg.p)bg={pi:o.pi,i:o.i,n:n,p:pn,pR:dist.pR};});});
  var by=null;
  if(haveY){hidden.forEach(function(o){var dist=tileDist(o.pi,o.i);if(dist.pY<=0)return;if(!by||dist.pY>by.p)by={pi:o.pi,i:o.i,p:dist.pY,pR:dist.pR};});}
  var dm=null;for(var qi=0;qi<myNums.length;qi++){var _c=buildDetector(pi,myNums[qi]);if(_c&&(!dm||_c._pc>dm._pc))dm=_c;}
  function gB(b,tag){return{kind:'guess',n:b.n,target:{pi:b.pi,i:b.i},text:'<span style="color:var(--gold)">'+tag+'</span>：'+me.name+'は '+S.players[b.pi].name+' の'+L(b.i)+'へ「'+b.n+'」（青'+Math.round(b.p*100)+'%・赤'+Math.round(b.pR*100)+'%）。'};}
  function gY(b){return{kind:'guessY',target:{pi:b.pi,i:b.i},text:'<span style="color:var(--gold)">黄</span>：'+me.name+'は '+S.players[b.pi].name+' の'+L(b.i)+'を黄と読んで「黄」宣言（黄'+Math.round(b.p*100)+'%）。'};}
  var skl=S.skill||0;
  // AIの性格（safe=慎重 / std=標準 / bold=大胆）
  var aiSt=S.aiStyle||'std';
  var redCap=(aiSt==='safe')?0.02:((aiSt==='bold')?0.12:0.05);   // 赤を引くリスクの許容上限
  var thr=Math.min(0.92,((aiSt==='safe')?0.78:((aiSt==='bold')?0.62:0.70))+skl*0.03);  // 自信を持って2人切断する閾値
  var lowThr=(aiSt==='safe')?0.68:((aiSt==='bold')?0.52:0.60);    // ほどほど閾値
  var detThr=0.60;                        // use the detector when this reliable
  var forcedFloor=0.45;                   // floor when breaking an all-pass deadlock
  if(bg&&bg.p>=thr&&bg.pR<=redCap)return gB(bg,'読み');
  if(by&&by.p>=thr&&by.pR<=redCap)return gY(by);
  if(dm&&dm._pc>=detThr)return dm;
  if(bg&&bg.p>=lowThr&&bg.pR<=redCap)return gB(bg,'読み');
  var er=S.equip.findIndex(function(e){return !e.used&&e.kind==='reveal'&&cutBlue(e.num)>=2;});
  if(er>=0&&bg)return{kind:'equip',ei:er,n:bg.n,text:'<span style="color:var(--blue)">装備</span>：'+me.name+'は自信が無いので「'+S.equip[er].name+'」で <b>'+bg.n+'</b> を探る。'};
  var ie=S.equip.findIndex(function(e){return !e.used&&e.kind==='ice'&&cutBlue(e.num)>=2;});
  if(ie>=0&&bg)return{kind:'guess',n:bg.n,target:{pi:bg.pi,i:bg.i},iceIdx:ie,text:'<span style="color:#2c7fe0">装備+読み</span>：'+me.name+'は「'+S.equip[ie].name+'」で安全に '+S.players[bg.pi].name+' の'+L(bg.i)+'へ「'+bg.n+'」。'};
  if(dm)return dm;
  if(by&&by.p>=lowThr&&by.pR<=redCap)return gY(by);
  if(bg&&bg.pR<=redCap&&bg.p>=forcedFloor)return gB(bg,'勝負');
  // break an all-pass deadlock: once everyone has passed around, force the safest action
  // パスは存在しない：自信のある手がなくても、最も安全な行動を選んで必ず実行する
  var cand=[];
  if(bg)cand.push({m:gB(bg,'勝負'),p:bg.p,pR:bg.pR});
  if(by)cand.push({m:gY(by),p:by.p,pR:by.pR});
  if(dm)cand.push({m:dm,p:dm._pc,pR:0});
  cand.sort(function(a,b){if(Math.abs(a.pR-b.pR)>0.001)return a.pR-b.pR;return b.p-a.p;});
  if(cand.length)return cand[0].m;
  var actT=me.tiles.filter(function(t){return !t.cut&&!t.done;});
  if(actT.length&&actT.every(function(t){return t.t==='R';}))return{kind:'revealAllRed',text:me.name+'は手札が赤のみになったため公開して処理する。'};
  // 保険（理論上ここには来ない）：スタック防止のためだけに残す
  return{kind:'pass',text:me.name+'：行動できる手がない。'};
}
function resolveMove(mv,pi){
  const me=S.players[pi];
  if(mv.kind!=='pass')S.passStreak=0;
  if(mv.kind==='solo'){let c=0;me.tiles.forEach(t=>{if(t.t==='B'&&t.n===mv.n&&!t.cut){t.cut=true;c++;}});clearHold(pi,mv.n);recomputeCuts();pushLog('<b>'+me.name+'</b>：単独切断 '+mv.n+'（残り全部を所持）→ '+c+'本切断。','ok');}
  else if(mv.kind==='soloY'){var cY=0;me.tiles.forEach(function(t){if(t.t==='Y'&&!t.cut&&!t.done){t.cut=true;cY++;}});S.yCut+=cY;pushLog('<b>'+me.name+'</b>：黄を単独で切断（残り全部を所持）→ '+cY+'本。','ok');}
  else if(mv.kind==='matchRev'){const T=S.players[mv.target.pi].tiles[mv.target.i];T.cut=true;const my=me.tiles.find(t=>t.t==='B'&&t.n===mv.n&&!t.cut);if(my)my.cut=true;clearHold(pi,mv.n);clearHold(mv.target.pi,mv.n);recomputeCuts();pushLog('<b>'+me.name+'</b> → '+S.players[mv.target.pi].name+'の'+L(mv.target.i)+'（公開'+mv.n+'）に「'+mv.n+'」宣言 → 切断。','ok');}
  else if(mv.kind==='matchRevY'){const T=S.players[mv.target.pi].tiles[mv.target.i];T.cut=true;const my=me.tiles.find(t=>t.t==='Y'&&!t.cut);if(my)my.cut=true;S.yCut+=2;pushLog('<b>'+me.name+'</b> → '+S.players[mv.target.pi].name+'の黄に「黄」宣言 → 黄ペア切断。','ok');}
  else if(mv.kind==='revealAllRed'){let c=0;me.tiles.forEach(t=>{if(t.t==='R'&&!t.done){t.done=true;t.revealed=true;S.redDone++;c++;}});pushLog('<b>'+me.name+'</b>：手札が赤のみ → 赤'+c+'本をすべて公開（無力化）。','ok');}
  else if(mv.kind==='equipLife'){S.equip[mv.ei].used=true;S.lives=(S.lives+1);pushLog('<b>'+me.name+'</b>：「'+S.equip[mv.ei].name+'」で残機+1。','ok');}
  else if(mv.kind==='guess'){const T=S.players[mv.target.pi].tiles[mv.target.i];const where=S.players[mv.target.pi].name+'の'+L(mv.target.i)+'';var gice=(mv.iceIdx!=null&&mv.iceIdx>=0)||S.iceShield;if(mv.iceIdx!=null&&mv.iceIdx>=0)S.equip[mv.iceIdx].used=true;
    noteHold(pi,mv.n);
    if(T.t==='B'&&T.n===mv.n){T.cut=true;const my=me.tiles.find(t=>t.t==='B'&&t.n===mv.n&&!t.cut);if(my)my.cut=true;clearHold(pi,mv.n);clearHold(mv.target.pi,mv.n);recomputeCuts();pushLog('<b>'+me.name+'</b> → '+where+'に「'+mv.n+'」宣言 → <b>当たり！</b>'+mv.n+'を2本切断。','ok');}
    else if(T.t==='R'){if(gice){pushLog('<b>'+me.name+'</b> → '+where+'に「'+mv.n+'」宣言 → 赤だったが万能氷で無効。次へ。');}else{T.cut=true;pushLog('<b>'+me.name+'</b> → '+where+'に「'+mv.n+'」宣言 → <b>赤を直撃！爆発</b>','bad');S.over='lose';}}
    else{T.revealed=true;if(gice){pushLog('<b>'+me.name+'</b> → '+where+'に「'+mv.n+'」宣言 → はずれ（実際は'+(T.t==='Y'?'黄':T.n)+'）。万能氷で残機維持・公開。');}else{S.lives--;pushLog('<b>'+me.name+'</b> → '+where+'に「'+mv.n+'」宣言 → はずれ（実際は'+(T.t==='Y'?'黄':T.n)+'）。残機-1・公開。','bad');}}}
  else if(mv.kind==='guessY'){const T=S.players[mv.target.pi].tiles[mv.target.i];const where=S.players[mv.target.pi].name+'の'+L(mv.target.i)+'';if(T.t==='Y'){T.cut=true;const my=me.tiles.find(t=>t.t==='Y'&&!t.cut&&!t.done);if(my)my.cut=true;S.yCut+=2;pushLog('<b>'+me.name+'</b> → '+where+'に「黄」宣言 → <b>黄ペア切断。</b>','ok');}else if(T.t==='R'){if(S.iceShield){pushLog('<b>'+me.name+'</b> → '+where+'に「黄」宣言 → 赤だったが<b>万能氷で無効</b>。','ok');}else{T.cut=true;pushLog('<b>'+me.name+'</b> → '+where+'に「黄」宣言 → <b>赤を直撃！爆発</b>','bad');S.over='lose';}}else{T.revealed=true;S.lives--;pushLog('<b>'+me.name+'</b> → '+where+'に「黄」宣言 → はずれ（実際は'+T.n+'）。残機-1・公開。','bad');}}
  else if(mv.kind==='detector'){S.players[pi].detector=false;detectorResolve(pi,mv.targetPi,[mv.i1,mv.i2],[mv.n]);}
  else if(mv.kind==='equip'){var e=S.equip[mv.ei];e.used=true;var P=S.players[pi];var f=P.tiles.find(function(t){return t.t==='B'&&t.n===mv.n&&!t.cut&&!t.done&&!t.revealed;});if(f){f.revealed=true;pushLog('<b>'+me.name+'</b>：装備「'+e.name+'」で自分の '+mv.n+' を1枚公開（仲間へのヒント）。','ok');}else{pushLog('<b>'+me.name+'</b>：装備「'+e.name+'」を使用（対象なし）。');}}
  else{S.passStreak=(S.passStreak||0)+1;pushLog(me.name+'：（行動なし）。');
    if(S.passStreak>=activePlayerCount()+2&&!S.over){S.over='lose';pushLog('手詰まり：これ以上コードを切る手段がありません → ミッション失敗…','bad');bumpSkill();}}
}
function handEmpty(pi){return !S.players[pi].tiles.some(function(t){return !t.cut&&!t.done;});}
function activePlayerCount(){var c=0;S.order.forEach(function(pi){if(!handEmpty(pi))c++;});return c;}
function advanceTurn(){if(S.extra){S.extra=false;pushLog('（追加手番：同じプレイヤーがもう一度）');}else{var pos=S.order.indexOf(S.turn);for(var k=0;k<S.order.length;k++){pos=(pos+1)%S.order.length;if(!handEmpty(S.order[pos]))break;}S.turn=S.order[pos];}S.sel=null;S.ownSel=null;S.iceShield=false;}function isEquipMove(k){return k==='equip'||k==='equipLife';}function scheduleAuto(){if(S._pending){setTimeout(function(){if(S.over||S.turn===0||!S._pending)return;var mv=S._pending;S._pending=null;resolveMove(mv,S.turn);checkEnd();if(S.infoPlace){render();saveGame();return;}if(!S.over&&isEquipMove(mv.kind)){S._pending=decideMove(S.turn);render();saveGame();scheduleAuto();}else{nextTurn();}},900);}}function nextTurn(){if(S.over){S._pending=null;render();saveGame();return;}advanceTurn();if(S.prio&&S.players[S.turn].tiles.some(function(t){return !t.cut&&!t.done;})&&!prioCanAct(S.turn)){S.over='lose';pushLog('<b>'+S.players[S.turn].name+'</b>：今は切断できるコードがない（優先順位の手詰まり）→ 爆発…失敗。','bad');bumpSkill();}S._pending=(!S.over&&S.turn!==0)?decideMove(S.turn):null;render();saveGame();scheduleAuto();}

function detectorResolve(actorPi,targetPi,idxs,decls){var act=S.players[actorPi];var DP=S.players[targetPi];var tiles=idxs.map(function(i){return DP.tiles[i];});
  decls.forEach(function(v){if(v!=='Y')noteHold(actorPi,v);});var hitTile=null,hitVal=null;for(var d=0;d<decls.length&&!hitTile;d++){var v=decls[d];for(var t=0;t<tiles.length;t++){var T=tiles[t];if(v==='Y'){if(T.t==='Y'&&!T.cut&&!T.done){hitTile=T;hitVal='Y';break;}}else{if(T.t==='B'&&T.n===v&&!T.cut&&!T.done){hitTile=T;hitVal=v;break;}}}}var declStr=decls.map(function(v){return v==='Y'?'黄':v;}).join('・');var posStr=idxs.map(function(i){return L(i);}).join('・');if(hitTile){var hitPos=L(DP.tiles.indexOf(hitTile));hitTile.cut=true;if(hitVal!=='Y')clearHold(targetPi,hitVal);var candIdx=[];act.tiles.forEach(function(t,ci){if(t.cut||t.done)return;if(hitVal==='Y'){if(t.t==='Y')candIdx.push(ci);}else{if(t.t==='B'&&t.n===hitVal)candIdx.push(ci);}});var humanActor=S.humanSeats&&S.humanSeats.indexOf(actorPi)>=0;if(humanActor&&candIdx.length>1){recomputeCuts();S.detPick={seat:actorPi,hitVal:hitVal};pushLog('<b>'+act.name+'</b>：探知機 → '+DP.name+' の'+posStr+'（'+idxs.length+'本）に「'+declStr+'」→ 命中！'+DP.name+'の'+hitPos+'の'+(hitVal==='Y'?'黄':hitVal)+'を切断。<b>自分のどれを切るか選びます。</b>','ok');}else{if(candIdx.length){act.tiles[candIdx[0]].cut=true;if(hitVal!=='Y')clearHold(actorPi,hitVal);}if(hitVal==='Y')S.yCut+=2;recomputeCuts();pushLog('<b>'+act.name+'</b>：探知機 → '+DP.name+' の'+posStr+'（'+idxs.length+'本）に「'+declStr+'」→ 命中！'+DP.name+'の'+hitPos+'の'+(hitVal==='Y'?'黄':hitVal)+'を切断。','ok');}}else{S.lives--;var opts=(S.humanSeats&&S.humanSeats.indexOf(targetPi)>=0)?idxs.filter(function(i){var tt=DP.tiles[i];return tt.t!=='R'&&!tt.cut&&!tt.done&&!tt.revealed;}):[];if(opts.length){S.infoPlace={actor:act.name,seat:targetPi,opts:opts};pushLog('<b>'+act.name+'</b>：探知機 → '+DP.name+' の'+posStr+'（'+idxs.length+'本）に「'+declStr+'」→ 外れ。残機-1。<b>対象のコードに情報トークンを置きます。</b>','bad');}else{var nr=tiles.filter(function(t){return t.t!=='R'&&!t.cut&&!t.done;});var infoPos=null,infoN=null;if(nr.length){nr[0].revealed=true;infoPos=L(DP.tiles.indexOf(nr[0]));infoN=nr[0].n;}pushLog('<b>'+act.name+'</b>：探知機 → '+DP.name+' の'+posStr+'（'+idxs.length+'本）に「'+declStr+'」→ 外れ。'+(infoPos?DP.name+'の'+infoPos+'（'+infoN+'）に情報トークンを置き':'情報トークンを置き')+'残機-1。','bad');}}}
function youCutSelect(pi,i){if(S.turn!==0||S.over||S.pick||S.pickInfo)return;if(S.labelMode){return;}if(S.detMode){if(pi===0)return;var _xt=S.players[pi].tiles[i];if(_xt&&_xt.xcode){alert('Xコードは探知機の対象にできません');return;}var cfg=DETCFG[S.detKind];if(S.detSel.length&&S.detSel[0].pi!==pi)S.detSel=[];if(!S.detSel.some(function(x){return x.pi===pi&&x.i===i;})&&S.detSel.length<cfg.tiles)S.detSel.push({pi:pi,i:i});render();return;}S.sel={pi,i};render();}
function startDetector(){if(S.pickInfo||!S.players[0].detector)return;S.detMode=true;S.detKind='free';S.detEquipIdx=-1;S.detSel=[];S.detDecls=[];S.sel=null;render();}
function cancelSwap(){S.swapMode=false;S.swapTarget=-1;S.swapEquipIdx=-1;render();}
function youSwapGive(idx){if(!S.swapMode)return;var giveT=S.players[0].tiles[idx];if(!giveT||giveT.cut||giveT.done)return;var tp=S.swapTarget;var TP=S.players[tp];var cands=TP.tiles.map(function(t,k){return k;}).filter(function(k){return !TP.tiles[k].cut&&!TP.tiles[k].done;});if(!cands.length){alert('相手に渡せるコードがありません');return;}var rk=cands[Math.floor(Math.random()*cands.length)];var getT=TP.tiles[rk];S.players[0].tiles.splice(idx,1);TP.tiles.splice(rk,1);TP.tiles.push(giveT);S.players[0].tiles.push(getT);TP.tiles.sort(function(a,b){return a.val-b.val;});S.players[0].tiles.sort(function(a,b){return a.val-b.val;});S.players[0].tiles.forEach(function(t){t.relRight=undefined;});TP.tiles.forEach(function(t){t.relRight=undefined;});S.equip[S.swapEquipIdx].used=true;pushLog('<b>あなた</b>：「イレカエシーバー」→ '+TP.name+' とコードを1枚ずつ交換（中身は伏せたまま）。','me');S.swapMode=false;S.swapTarget=-1;S.swapEquipIdx=-1;render();saveGame();}
function startLabel(kind,i){if(S.pickInfo||S.turn!==0)return;S.labelMode=true;S.labelKind=kind;S.labelEquipIdx=i;S.labelSel=[];S.sel=null;render();}
function cancelLabel(){S.labelMode=false;S.labelSel=[];S.labelKind=null;S.labelEquipIdx=-1;render();}
function youLabelSelect(idx){if(!S.labelMode)return;var t=S.players[0].tiles[idx];if(!t)return;if(t.xcode){alert('Xコードにはラベルを使えません');return;}if(!S.labelSel.some(function(x){return x.i===idx;})&&S.labelSel.length<2)S.labelSel.push({pi:0,i:idx});if(S.labelSel.length===2)resolveLabel();else render();}
function resolveLabel(){var a=S.labelSel[0],b=S.labelSel[1];if(a.pi!==b.pi){alert('同じ台の2本を選んでね');S.labelSel=[];render();return;}var pi=a.pi;var P=S.players[pi];var lo=Math.min(a.i,b.i),hi=Math.max(a.i,b.i);if(hi!==lo+1){alert('隣り合う2本を選んでね');S.labelSel=[];render();return;}var t1=P.tiles[lo],t2=P.tiles[hi];function mvv(t){return t.t==='B'?('N'+t.n):(t.t==='Y'?'Y':('R'+t.n));}var same=(t1.t!=='R'&&t2.t!=='R'&&mvv(t1)===mvv(t2));var wantSame=(S.labelKind==='equal');if(same!==wantSame){alert(wantSame?'この2本は同じ数字ではないので、イコールラベルは使えません':'この2本は同じ数字なので、コトナルラベルは使えません');S.labelSel=[];render();return;}P.tiles[lo].relRight=wantSame?'=':'\u2260';S.equip[S.labelEquipIdx].used=true;pushLog('<b>あなた</b>：「'+S.equip[S.labelEquipIdx].name+'」→ '+P.name+' の'+L(lo)+'・'+L(hi)+'は '+(wantSame?'＝（同じ）':'≠（違う）')+'。','me');S.labelMode=false;S.labelSel=[];S.labelKind=null;S.labelEquipIdx=-1;render();saveGame();}
function startEquipDetector(kind,i){if(S.pickInfo||S.turn!==0)return;S.detMode=true;S.detKind=kind;S.detEquipIdx=i;S.detSel=[];S.detDecls=[];S.sel=null;render();}
function cancelDetector(){S.detMode=false;S.detSel=[];S.detDecls=[];S.detKind='free';S.detEquipIdx=-1;render();}
function youOwnSelect(idx){if(S.turn!==0||S.over)return;if(S.pickInfo||S.pick||S.detPick||S.infoPlace||S.swapMode||S.labelMode)return;var t=S.players[0].tiles[idx];if(!t||t.cut||t.done)return;if(S.detMode){youDetDeclare(t.t==='Y'?'Y':t.n);return;}S.ownSel=(S.ownSel===idx)?null:idx;render();}
function youCut2(){if(S.turn!==0||S.over||S.detMode)return;if(!S.sel||S.ownSel==null){alert('相手の手札と自分の手札を1枚ずつタップしてね');return;}var my=S.players[0].tiles[S.ownSel];var val=(my.t==='Y')?'Y':my.n;var ownIdx=S.ownSel;S.ownSel=null;youGuess(val);if(S.pick)youPickOwn(ownIdx);}
function youCut1(){if(S.turn!==0||S.over||S.detMode)return;if(S.ownSel==null){alert('単独で切る自分の手札を1枚タップしてね');return;}var my=S.players[0].tiles[S.ownSel];S.ownSel=null;if(my.t==='Y')youSoloYellow();else youSolo(my.n);}
function youDetBtn(){if(S.turn!==0||S.over)return;if(S.detMode){cancelDetector();return;}if(!S.players[0].detector){alert('フツーノ探知機は使用済みです');return;}startDetector();}
function youDetDeclare(val){var cfg=DETCFG[S.detKind];if(typeof val==='number'&&prioLocked(val)){alert('「'+val+'」はまだ切断できません（優先順位）');return;}if(val==='Y'&&!cfg.yellow){alert('数値(1〜12)を宣言してください');return;}if(S.detSel.length!==cfg.tiles){alert('仲間1人のコードを'+cfg.sel+'タップして選んでね');return;}if(cfg.decls===1){if(val==='Y'){if(!S.players[0].tiles.some(function(t){return t.t==='Y'&&!t.cut&&!t.done;})){alert('合わせる黄が自分の手札にありません');return;}}else{if(!S.players[0].tiles.some(function(t){return t.t==='B'&&t.n===val&&!t.cut&&!t.done;})){alert('合わせる'+val+'が自分の手札にありません');return;}}}S.detDecls.push(val);if(S.detDecls.length<cfg.decls){render();return;}var _idxs=S.detSel.map(function(x){return x.i;});var _tpi=S.detSel[0].pi;var _decls=S.detDecls.slice();var _DP=S.players[_tpi];var _tiles=_idxs.map(function(i){return _DP.tiles[i];});var _hit=null,_hv=null;for(var _d=0;_d<_decls.length&&!_hit;_d++){var _v=_decls[_d];for(var _t=0;_t<_tiles.length;_t++){var _T=_tiles[_t];if(_v==='Y'){if(_T.t==='Y'&&!_T.cut&&!_T.done){_hit=_T;_hv='Y';break;}}else{if(_T.t==='B'&&_T.n===_v&&!_T.cut&&!_T.done){_hit=_T;_hv=_v;break;}}}}if(_hit){var _cand=(_hv==='Y')?S.players[0].tiles.filter(function(t){return t.t==='Y'&&!t.cut&&!t.done;}).length:S.players[0].tiles.filter(function(t){return t.t==='B'&&t.n===_hv&&!t.cut&&!t.done;}).length;if(_cand>1){S.detPick={tpi:_tpi,hitIdx:_DP.tiles.indexOf(_hit),hitVal:_hv,idxCount:_idxs.length,idxs:_idxs.slice(),equipIdx:S.detEquipIdx};S.detMode=false;S.detSel=[];S.detDecls=[];S.detKind='free';S.detEquipIdx=-1;render();return;}}detectorResolve(0,_tpi,_idxs,_decls);if(S.detEquipIdx>=0){S.equip[S.detEquipIdx].used=true;}else{S.players[0].detector=false;}S.detMode=false;S.detSel=[];S.detDecls=[];S.detKind='free';S.detEquipIdx=-1;checkEnd();nextTurn();}
function youGuess(val){
  if(S.detMode){youDetDeclare(val);return;}
  if(S.pickInfo)return;
  if(S.pick)return;
  if(!S.sel){alert('まず仲間のタイルをタップして選んでね');return;}
  if(val!=='Y'&&prioLocked(val)){alert('「'+val+'」はまだ切断できません（優先順位）');return;}
  S.passStreak=0;const T=S.players[S.sel.pi].tiles[S.sel.i];const where=S.players[S.sel.pi].name+'の'+L(S.sel.i)+'';
  if(val==='Y'){const my=S.players[0].tiles.find(t=>t.t==='Y'&&!t.cut&&!t.done);if(!my){alert('自分に黄がありません（合わせる黄が必要）');return;}
    if(T.t==='Y'){T.cut=true;my.cut=true;S.yCut+=2;pushLog('<b>あなた</b> → '+where+'に「黄」宣言 → 黄ペア切断。','me');}
    else if(T.t==='R'){if(S.iceShield){S.iceShield=false;pushLog('<b>あなた</b> → '+where+'に「黄」宣言 → 赤だったが<b>万能氷で無効</b>。次へ。');}else{T.cut=true;pushLog('<b>あなた</b> → '+where+'に「黄」宣言 → <b>赤を直撃！爆発</b>','bad');S.over='lose';}}
    else{T.revealed=true;if(S.iceShield){S.iceShield=false;pushLog('<b>あなた</b> → '+where+'に「黄」宣言 → はずれ（実際は'+T.n+'）。<b>万能氷で残機維持</b>・公開。');}else{S.lives--;pushLog('<b>あなた</b> → '+where+'に「黄」宣言 → はずれ（実際は'+T.n+'）。残機-1。','bad');}}}
  else{const n=val;const my=S.players[0].tiles.find(t=>t.t==='B'&&t.n===n&&!t.cut&&!t.done);if(!my){alert('合わせる'+n+'が自分の手札にありません');return;}
    noteHold(0,n);
    if(T.t==='B'&&T.n===n){var owns=S.players[0].tiles.map((t,idx)=>({t,idx})).filter(o=>o.t.t==='B'&&o.t.n===n&&!o.t.cut&&!o.t.done);if(owns.length>1){S.pick={tpi:S.sel.pi,ti:S.sel.i,n:n};render();return;}T.cut=true;my.cut=true;clearHold(0,n);clearHold(S.sel.pi,n);recomputeCuts();pushLog('<b>あなた</b> → '+where+'に「'+n+'」宣言 → <b>当たり！</b>'+n+'を2本切断。','me');}
    else if(T.t==='R'){if(S.iceShield){S.iceShield=false;pushLog('<b>あなた</b> → '+where+'に「'+n+'」宣言 → 赤だったが<b>万能氷で無効</b>。次へ。');}else{T.cut=true;pushLog('<b>あなた</b> → '+where+'に「'+n+'」宣言 → <b>赤を直撃！爆発</b>','bad');S.over='lose';}}
    else{T.revealed=true;if(S.iceShield){S.iceShield=false;pushLog('<b>あなた</b> → '+where+'に「'+n+'」宣言 → はずれ（実際は'+(T.t==='Y'?'黄':T.n)+'）。<b>万能氷で残機維持</b>・公開。');}else{S.lives--;pushLog('<b>あなた</b> → '+where+'に「'+n+'」宣言 → はずれ（実際は'+(T.t==='Y'?'黄':T.n)+'）。残機-1。','bad');}}}
  S.sel=null;checkEnd();nextTurn();
}
function youPickOwn(idx){if(!S.pick)return;S.passStreak=0;var t=S.players[0].tiles[idx];if(!(t&&t.t==='B'&&t.n===S.pick.n&&!t.cut&&!t.done))return;var T=S.players[S.pick.tpi].tiles[S.pick.ti];var where=S.players[S.pick.tpi].name+'の'+L(S.pick.ti)+'';T.cut=true;t.cut=true;clearHold(0,S.pick.n);clearHold(S.pick.tpi,S.pick.n);recomputeCuts();pushLog('<b>あなた</b> → '+where+'に「'+S.pick.n+'」宣言 → <b>当たり！</b>'+S.pick.n+'を2本切断（自分のコードを選択）。','me');S.pick=null;S.sel=null;checkEnd();nextTurn();}
function youDetPickOwn(idx){if(!S.detPick)return;S.passStreak=0;var dp=S.detPick;var t=S.players[0].tiles[idx];var ok=(dp.hitVal==='Y')?(t&&t.t==='Y'&&!t.cut&&!t.done):(t&&t.t==='B'&&t.n===dp.hitVal&&!t.cut&&!t.done);if(!ok)return;var DP=S.players[dp.tpi];var hitTile=DP.tiles[dp.hitIdx];hitTile.cut=true;t.cut=true;if(dp.hitVal==='Y')S.yCut+=2;else{clearHold(0,dp.hitVal);clearHold(dp.tpi,dp.hitVal);}recomputeCuts();var _pos=(dp.idxs||[]).map(function(i){return L(i);}).join('・');pushLog('<b>あなた</b>：探知機 → '+DP.name+' の'+_pos+'（'+dp.idxCount+'本）に「'+(dp.hitVal==='Y'?'黄':dp.hitVal)+'」→ 命中！'+DP.name+'の'+L(dp.hitIdx)+'を切断（自分のコードは選択）。','me');if(dp.equipIdx>=0){S.equip[dp.equipIdx].used=true;}else{S.players[0].detector=false;}S.detPick=null;checkEnd();nextTurn();}
function placeMissInfo(idx){if(!S.infoPlace||!S.infoPlace.opts||S.infoPlace.opts.indexOf(idx)<0)return;var t=S.players[0].tiles[idx];if(!t||t.cut||t.done||t.revealed)return;t.revealed=true;var lbl=(t.t==='Y')?(t.n+'.1'):t.n;pushLog('<b>あなた</b>：情報トークンを自分の'+L(idx)+'（'+lbl+'）に置いた。','me');S.infoPlace=null;checkEnd();if(S.over){render();saveGame();return;}nextTurn();}
function cancelPick(){S.pick=null;render();}
function runInfoPhase(){if(!S.infoPhase)return;if(S.infoIdx>=S.order.length){S.infoPhase=false;S.turn=S.captain;S._pending=(!S.over&&S.turn!==0)?decideMove(S.turn):null;pushLog('全員が情報トークンを置いた。切断スタート！');render();saveGame();scheduleAuto();return;}var pi=S.order[S.infoIdx];S.turn=pi;if(pi===0){S.pickInfo=true;render();saveGame();return;}var P=S.players[pi];var c=P.tiles.map(function(t,i){return i;}).filter(function(i){return P.tiles[i].t==='B'&&!P.tiles[i].revealed&&!P.tiles[i].cut&&!P.tiles[i].done;});if(c.length){var idx=c[Math.floor(Math.random()*c.length)];P.tiles[idx].revealed=true;pushLog('<b>'+P.name+'</b> が情報トークンを '+L(idx)+'（'+P.tiles[idx].n+'）に置いた。');}S.infoIdx++;render();saveGame();setTimeout(runInfoPhase,900);}
function youPlaceInfo(idx){if(!S.pickInfo)return;var t=S.players[0].tiles[idx];if(!(t&&t.t==='B'&&!t.cut&&!t.done&&!t.revealed))return;t.revealed=true;S.pickInfo=false;pushLog('<b>あなた</b> が情報トークンを '+L(idx)+'（'+t.n+'）に置いた。','me');S.infoIdx++;render();saveGame();runInfoPhase();}
function youSolo(n){if(S.pickInfo)return;if(prioLocked(n)){alert('「'+n+'」はまだ切断できません（優先順位）');return;}S.passStreak=0;const t=S.players[0].tiles.filter(x=>x.t==='B'&&x.n===n&&!x.cut);if(t.length<2||t.length!==(4-cutBlue(n))){alert('単独切断は「その数字の残り全部を自分が持つ」ときだけ');return;}t.forEach(x=>x.cut=true);recomputeCuts();pushLog('<b>あなた</b>：単独切断 '+n+' → '+t.length+'本切断。','me');checkEnd();nextTurn();}
function youSoloYellow(){if(S.pickInfo)return;S.passStreak=0;var mine=S.players[0].tiles.filter(function(t){return t.t==='Y'&&!t.cut&&!t.done;});var total=0;S.players.forEach(function(p){p.tiles.forEach(function(t){if(t.t==='Y'&&!t.cut&&!t.done)total++;});});if(mine.length<2||mine.length!==total){alert('黄の単独切断は「残りの黄を全部自分が持つ（2枚以上）」ときだけ');return;}var c=0;mine.forEach(function(t){t.cut=true;c++;});S.yCut+=c;pushLog('<b>あなた</b>：黄を単独で切断 → '+c+'本切断。','me');checkEnd();nextTurn();}
function youRevealRed(){if(S.pickInfo)return;const act=S.players[0].tiles.filter(t=>!t.cut&&!t.done);if(!act.length||!act.every(t=>t.t==='R')){alert('赤の公開は「手札が赤のみ」になったときだけできます');return;}let c=0;act.forEach(t=>{t.done=true;t.revealed=true;S.redDone++;c++;});pushLog('<b>あなた</b>：手札が赤のみ → 赤'+c+'本をすべて公開（無力化）。','me');checkEnd();nextTurn();}
function useEquip(i){if(S.pickInfo)return;const e=S.equip[i];if(e.used||S.over)return;if(e.kind==='himitsu'){if(S.yCut<=0){alert('ヒミツ底は黄コードを切断すると使えます');return;}var hpool=[1,2,3,4,5,6,7,8,9,10,11,12].filter(function(id){return !S.equip.some(function(x){return x.num===id;});});if(hpool.length<2){alert('追加できる装備が残っていません');return;}var hadd=[];for(var ha=0;ha<2&&hpool.length;ha++){hadd.push(hpool.splice(Math.floor(Math.random()*hpool.length),1)[0]);}hadd.forEach(function(id){S.equip.push({id:id,name:EQUIP[id].name,kind:EQUIP[id].kind,used:false,num:id});});S.equip.sort(function(x,y){return x.num-y.num;});e.used=true;pushLog('装備「ヒミツ底」：新たな装備「'+hadd.map(function(id){return EQUIP[id].name;}).join('」「')+'」を盤面に追加。','ok');checkEnd();render();saveGame();return;}if(cutBlue(e.num)<2){alert('この装備は対応する数字 '+e.num+' のペアが1組切られると使えます');return;}
  if(e.kind==='radar'){var rv=prompt('特定したい数値(1-12)：その数字を持つ人を特定');var rn=parseInt(rv);if(isNaN(rn))return;var hold=[];S.players.forEach(function(p){if(p.tiles.some(function(t){return t.t==='B'&&t.n===rn&&!t.cut&&!t.done;}))hold.push(p.name);});e.used=true;pushLog('装備「'+e.name+'」：番号'+rn+' を持っているのは → '+(hold.length?hold.join('、'):'いない')+'。','ok');checkEnd();render();saveGame();return;}
  if(e.kind==='super'){if(S.turn!==0){alert('スーパー探知機はあなたの手番に使います');return;}var tv=prompt('対象の仲間（'+mateList()+'）');var tp=parseInt(tv);if(!isMate(tp))return;var nv=prompt('宣言する数値(1-12)。相手の手札全体が対象、あれば1枚切断');var sn=parseInt(nv);if(isNaN(sn)||sn<1||sn>12)return;if(!S.players[0].tiles.some(function(t){return t.t==='B'&&t.n===sn&&!t.cut&&!t.done;})){alert('合わせる'+sn+'が自分の手札にありません');return;}var DP=S.players[tp];var sidxs=[];DP.tiles.forEach(function(t,ii){if(!t.cut&&!t.done)sidxs.push(ii);});var shit=DP.tiles.find(function(t){return t.t==='B'&&t.n===sn&&!t.cut&&!t.done;});if(shit){var scand=S.players[0].tiles.filter(function(t){return t.t==='B'&&t.n===sn&&!t.cut&&!t.done;}).length;if(scand>1){S.detPick={tpi:tp,hitIdx:DP.tiles.indexOf(shit),hitVal:sn,idxCount:sidxs.length,idxs:sidxs.slice(),equipIdx:i};render();return;}}detectorResolve(0,tp,sidxs,[sn]);e.used=true;checkEnd();nextTurn();return;}
  if(e.kind==='mitsu'){if(S.turn!==0){alert('ミッツケル探知機はあなたの手番に使います');return;}startEquipDetector('mitsu',i);return;}
  if(e.kind==='dochi'){if(S.turn!==0){alert('ドッチカアタ・レイはあなたの手番に使います');return;}startEquipDetector('dochi',i);return;}
  if(e.kind==='kotonal'){if(S.turn!==0){alert('コトナルラベルはあなたの手番で使ってください');return;}startLabel('kotonal',i);return;}
  if(e.kind==='equal'){if(S.turn!==0){alert('イコールラベルはあなたの手番で使ってください');return;}startLabel('equal',i);return;}
  if(e.kind==='battery'){var usedIdx=[];S.players.forEach(function(p,bi){if(!p.detector)usedIdx.push(bi);});if(usedIdx.length===0){alert('探知機を使ったプレイヤーがいないため回復できません');return;}var names=usedIdx.map(function(bi){return bi+'='+S.players[bi].name;}).join(' / ');var bv=prompt('探知機を回復するプレイヤーを選択（最大2人・カンマ区切り）。使用済み：'+names);if(bv==null)return;var bsel=[];bv.split(/[ ,、\s]+/).forEach(function(x){var pn=parseInt(x);if(usedIdx.indexOf(pn)>=0&&bsel.indexOf(pn)<0)bsel.push(pn);});bsel=bsel.slice(0,2);if(bsel.length===0){alert('使用済みのプレイヤー番号を入力してください');return;}bsel.forEach(function(bi){S.players[bi].detector=true;});e.used=true;pushLog('装備「非常電池」：'+bsel.map(function(bi){return S.players[bi].name;}).join('・')+' の探知機の使用権を回復。','ok');checkEnd();render();saveGame();return;}
  if(e.kind==='ice'){if(S.turn!==0){alert('万能氷は自分の手番（行動の前）に使います');return;}S.iceShield=true;e.used=true;pushLog('装備「'+e.name+'」：この手番の失敗ペナルティを無効化（赤でも爆発しない・残機維持）。','ok');checkEnd();render();saveGame();return;}
  if(e.kind==='swap'){if(S.turn!==0){alert('入れ替えはあなたの手番で使ってください');return;}var sv=prompt('渡す相手（'+mateList()+'）');var sp=parseInt(sv);if(!isMate(sp))return;S.swapMode=true;S.swapTarget=sp;S.swapEquipIdx=i;render();return;}
  if(e.kind==='life'){S.lives=(S.lives+1);e.used=true;pushLog('装備「'+e.name+'」：残機+1。','ok');}
  else if(e.kind==='extra'){if(S.turn!==0){alert('いつでもコーヒーはあなたの手番に使います');return;}var cv=prompt('ゲームを再開するプレイヤーを選択（'+mateList()+'）');var cp=parseInt(cv);if(!isMate(cp))return;e.used=true;S.sel=null;S.iceShield=false;S.turn=cp;pushLog('装備「'+e.name+'」：'+S.players[cp].name+' からゲームを再開します。','me');S._pending=(!S.over&&S.turn!==0)?decideMove(S.turn):null;checkEnd();render();saveGame();scheduleAuto();return;}
  else if(e.kind==='reveal'){const v=prompt('自分の手札で公開する番号(1-12)：自分のその青を1枚オモテに（仲間へのヒント）');const n=parseInt(v);if(isNaN(n))return;var P0=S.players[0];var f=P0.tiles.find(function(t){return t.t==='B'&&t.n===n&&!t.cut&&!t.done&&!t.revealed;});if(f){f.revealed=true;e.used=true;pushLog('装備「'+e.name+'」：自分の '+n+' を1枚公開（仲間へのヒント）。','ok');}else{alert('その番号の自分の青い伏せ札が見つかりません');return;}}
  else{e.used=true;pushLog('装備「'+e.name+'」：効果はカード文どおり手動適用（使用済みに）。');}
  checkEnd();render();saveGame();
}
function tileHTML(t,shown){
  if(!shown)return '<div class="tile back"></div>';
  const cut=(t.cut||t.done)?' cut':'';
  // info token only on blue/yellow (赤には情報トークンを置かない)
  const tk=(t.revealed&&t.t==='Y')?'<span class="tk yel"></span>':((t.revealed&&t.t==='B')?'<span class="tk">'+t.n+'</span>':'');
  if(t.t==='B')return '<div class="tile b'+cut+'" data-n="'+t.n+'">'+tk+'<span class="big">'+t.n+'</span></div>';
  if(t.t==='Y')return '<div class="tile y'+cut+'">'+tk+'<span class="big">'+t.n+'.1</span></div>';
  return '<div class="tile r'+cut+'"><span class="big">'+t.n+'.5</span></div>';
}
function render(){
  if(!S)return;
  const bn=g('banner');bn.className='';bn.innerHTML='';
  if(S.over==='win'){bn.className='banner win';bn.textContent='🎉 ミッション成功！爆弾解除';}
  if(S.over==='lose'){bn.className='banner lose';bn.textContent='💥 失敗…爆発しました';}
  g('kLives').textContent='❤️'.repeat(Math.max(0,S.lives))+'🖤'.repeat(Math.max(0,(S.maxLives||S.players.length)-S.lives));
  
  const tb=g('turnbar');tb.innerHTML='';(S.order||[0,1,2,3]).forEach((pi)=>{const p=S.players[pi];const s=document.createElement('span');s.className='pill'+(S.turn===pi?' on':'');s.textContent=(pi===S.captain?'👑':'')+p.name;tb.appendChild(s);});
  const da=g('declareArea');
  if(S.infoPlace){da.innerHTML='<div class="declare" style="border-color:var(--gold)">探知機が外れました。<b>探知の対象になった自分のコードを1枚タップ</b>して情報トークンを置いてください。</div>';}
  else if(S.over){var oh='<div class="muted">ゲーム終了。「最初から」で新しい卓を配れます。</div>';if(!S.showAll){oh+='<div class="btnrow"><button class="sec" onclick="revealAll()">全員の手札を公開（答え合わせ）</button></div>';}else{oh+='<div class="muted" style="margin-top:6px;color:var(--gold)">全員の手札を公開中。「仲間の卓」で答え合わせできます。</div>';}da.innerHTML=oh;}
  else if(S.turn===0&&S.pickInfo){
    da.innerHTML='<div class="declare" style="border-color:var(--green)">ゲーム開始：<b>自分の情報トークンを置きます</b>。下の手札から<b>青コード（数字）を1枚タップ</b>して公開してください（黄・赤は不可。仲間3人は自動で公開済み）。</div>';
  }
  else if(S.turn===0&&S.swapMode){
    da.innerHTML='<div class="declare" style="border-color:var(--gold)">イレカエシーバー：'+S.players[S.swapTarget].name+' に渡す<b>自分のコードを1枚</b>下の手札からタップ。相手からも1枚（伏せたまま）受け取ります。<button class="ghost" style="margin-left:6px;padding:4px 8px" onclick="cancelSwap()">取消</button></div>';
  }
  else if(S.turn===0&&S.labelMode){
    var lname=(S.labelKind==='equal')?'イコールラベル（同じ2本）':'コトナルラベル（違う2本）';
    da.innerHTML='<div class="declare" style="border-color:var(--gold)">'+lname+'：自分の手札の<b>隣り合う2本</b>をタップ（公開済み・切断済みも可）。選択 '+S.labelSel.length+'/2 <button class="ghost" style="margin-left:6px;padding:4px 8px" onclick="cancelLabel()">取消</button></div>';
  }
  else if(S.turn===0&&S.detMode){
    var cfg=DETCFG[S.detKind];
    da.innerHTML='<div class="declare" style="border-color:var(--green)">'+cfg.name+'：<b>相手の手札を'+cfg.sel+'</b>＋<b>自分の手札（数字）を'+cfg.decls+'枚</b>タップ。赤に当たっても爆発しません。選択 '+S.detSel.length+'/'+cfg.tiles+'・数字 '+S.detDecls.length+'/'+cfg.decls+' <button class="ghost" style="margin-left:6px;padding:4px 8px" onclick="cancelDetector()">取消</button></div>';
  }
  else if(S.turn===0&&S.detPick){
    da.innerHTML='<div class="declare" style="border-color:var(--green)">探知が命中！ <b>自分のどの '+(S.detPick.hitVal==='Y'?'黄':S.detPick.hitVal)+' を切るか</b>を、下の手札でタップして選んでください。</div>';
  }
  else if(S.turn===0){
    var h='';
    if(S.pick){h+='<div class="declare" style="border-color:var(--gold)">「'+S.pick.n+'」が当たり！自分の '+S.pick.n+' をタップして切ってください。<button class="ghost" style="margin-left:6px;padding:4px 8px" onclick="cancelPick()">取消</button></div>';}
    else{var selTxt=S.sel?(S.players[S.sel.pi].name+'の'+L(S.sel.i)):'なし';var ot=(S.ownSel!=null)?S.players[0].tiles[S.ownSel]:null;var ownTxt=ot?('自分の'+L(S.ownSel)+'（'+(ot.t==='Y'?'黄':ot.n)+'）'):'なし';h+='<div class="declare"><b>あなたの番</b>。相手＋自分の手札をタップ→下のボタンで行動。<br>相手：<b>'+selTxt+'</b> ／ 自分：<b>'+ownTxt+'</b></div>';}
    da.innerHTML=h;
    } else { if(S.infoPhase){da.innerHTML='<div class="declare">'+S.players[S.turn].name+' が情報トークンを置いています…</div>';} else {const mv=S._pending||decideMove(S.turn);da.innerHTML='<div class="declare"><b>'+S.players[S.turn].name+'</b> の番（自動進行中…）：<br>'+mv.text+'</div>';} }
  var ab=g('actionbar');if(ab){if(S.turn===0&&!S.over&&!S.pickInfo&&!S.infoPlace&&!S.pick&&!S.detPick&&!S.swapMode&&!S.labelMode){var det=S.players[0].detector;var dl=S.detMode?'探知機：選択中（取消）':(det?'フツーノ探知機':'探知機 使用済');var soloOK=false;if(S.ownSel!=null){var _ot=S.players[0].tiles[S.ownSel];if(_ot&&!_ot.cut&&!_ot.done){if(_ot.t==='Y'){var _my=S.players[0].tiles.filter(function(t){return t.t==='Y'&&!t.cut&&!t.done;}).length;var _tot=0;S.players.forEach(function(p){p.tiles.forEach(function(t){if(t.t==='Y'&&!t.cut&&!t.done)_tot++;});});soloOK=(_my>=2&&_my===_tot);}else if(_ot.t==='B'){var _c=S.players[0].tiles.filter(function(t){return t.t==='B'&&t.n===_ot.n&&!t.cut&&!t.done;}).length;soloOK=(_c>=2&&_c===(4-cutBlue(_ot.n)));}}}var hb='<div class="btnrow">';hb+='<button class="blue" onclick="youCut2()">切断（2人）</button>';hb+='<button class="'+(soloOK?'blue':'sec')+'" onclick="youCut1()">切断（1人）</button>';hb+='<button class="'+((det||S.detMode)?'blue':'sec')+'" '+((det||S.detMode)?'':'disabled')+' onclick="youDetBtn()">'+dl+'</button>';var ma=S.players[0].tiles.filter(function(t){return !t.cut&&!t.done;});if(ma.length>0&&ma.every(function(t){return t.t==='R';}))hb+='<button class="danger" onclick="youRevealRed()">赤を全部公開</button>';hb+='</div>';ab.innerHTML=hb;}else{ab.innerHTML='';}}
  g('log').innerHTML=S.log.slice(0,60).join('');
  // track
  const lw=g('ledger');lw.innerHTML='';
  for(let n=1;n<=12;n++){const rem=4-cutBlue(n);const c=document.createElement('div');c.className='tnum'+(rem===0?' done':'')+(prioLocked(n)?' locked':'');c.innerHTML='<div class="n">'+n+(prioLocked(n)?' 🔒':'')+'</div><div class="d">残<b>'+rem+'</b></div>';lw.appendChild(c);
    if(n<12){const gap=document.createElement('div');
      const y=findTile(t=>t.t==='Y'&&Math.abs(t.val-(n+0.1))<0.001);
      const r=findTile(t=>t.t==='R'&&Math.abs(t.val-(n+0.5))<0.001);
      var rPart,rHas=false;
      if(S.redUncertain&&S.redCandidates){ if(S.redCandidates.indexOf(n)>=0){rPart='<div class="mk rq">?</div>';rHas=true;}else{rPart='<div class="mkspace"></div>';} }
      else { if(r){rPart='<div class="mk r'+(r.done?' off':'')+'"></div>';rHas=true;}else{rPart='<div class="mkspace"></div>';} }
      var yPart,yHas=false;
      if(S.yellowUncertain&&S.yellowCandidates){ if(S.yellowCandidates.indexOf(n)>=0){yPart='<div class="mk yq">?</div>';yHas=true;}else{yPart='<div class="mkspace"></div>';} }
      else { if(y){yPart='<div class="mk y'+(y.cut?' off':'')+'"></div>';yHas=true;}else{yPart='<div class="mkspace"></div>';} }
      gap.className='tgap'+((rHas||yHas)?'':' empty');
      gap.innerHTML=yPart+rPart;
      lw.appendChild(gap);}}
  var ps=g('prioStrip');if(ps){if(S.prio){var ph='<div class="prio"><span class="plabel">順番に切断</span>';S.prio.nums.forEach(function(nn,ii){var st=(ii<S.prio.ptr)?'done':(ii===S.prio.ptr?'cur':'lock');ph+='<span class="pchip '+st+'">'+String.fromCharCode(97+ii)+': <b>'+nn+'</b> '+(st==='done'?'✓':(st==='cur'?'◀今ここ':'🔒'))+'</span>';if(ii<2)ph+='<span class="parrow">→</span>';});ph+='</div>';ps.innerHTML=ph;}else ps.innerHTML='';}
  // all hands, ordered from captain (親) downward; own hand highlighted
  const hw=g('hands');hw.innerHTML='';
  var _ci=S.order.indexOf(S.captain);if(_ci<0)_ci=0;var _disp=[];for(var _k=0;_k<S.order.length;_k++)_disp.push(S.order[(_ci+_k)%S.order.length]);
  _disp.forEach(function(pi){var p=S.players[pi];var isYou=(pi===0);var active=p.tiles.filter(function(t){return !t.cut&&!t.done;}).length;
    var seat=document.createElement('div');seat.className='seat'+(S.turn===pi?' active':'')+(isYou?' you':'');
    var cap=(pi===S.captain)?'<span class="capmark">親</span> ':'';
    var det='<span class="detchip '+(p.detector?'avail':'used')+'">探知機 '+(p.detector?'●使用可':'✓使用済')+'</span>';
    var nm=isYou?('あなた（'+p.name+'）'):p.name;
    seat.innerHTML='<div class="nm"><span class="nmL">'+cap+nm+det+'</span><span class="muted">残り'+active+'</span></div>';
    var tw=document.createElement('div');tw.className='tiles';var pendRel=null;
    p.tiles.forEach(function(t,i){var act=!t.cut&&!t.done;
      if(pendRel){var rmk=document.createElement('div');rmk.className='rel '+(pendRel==='='?'eq':'ne');rmk.textContent=pendRel;tw.appendChild(rmk);pendRel=null;}
      var shown=isYou?true:(t.revealed||t.cut||t.done||S.showAll);
      var tmp=document.createElement('div');tmp.innerHTML=tileHTML(t,shown);var el=tmp.firstChild;
      if(isYou){
        if(S.pick&&t.t==='B'&&t.n===S.pick.n&&!t.cut&&!t.done){el.classList.add('sel');el.onclick=()=>youPickOwn(i);}
        if(S.detPick){var _okk=(S.detPick.hitVal==='Y')?(t.t==='Y'&&!t.cut&&!t.done):(t.t==='B'&&t.n===S.detPick.hitVal&&!t.cut&&!t.done);if(_okk){el.classList.add('sel');el.onclick=()=>youDetPickOwn(i);}}
        if(S.infoPlace&&S.infoPlace.opts&&S.infoPlace.opts.indexOf(i)>=0){el.classList.add('sel');el.onclick=()=>placeMissInfo(i);}
        if(S.pickInfo&&t.t==='B'&&!t.cut&&!t.done){el.classList.add('sel');el.onclick=()=>youPlaceInfo(i);}
        if(S.swapMode&&!t.cut&&!t.done){el.classList.add('sel');el.onclick=()=>youSwapGive(i);}
        if(S.labelMode){el.onclick=()=>youLabelSelect(i);if(S.labelSel.some(function(x){return x.i===i;}))el.classList.add('sel');}
        if(S.turn===0&&!S.over&&act&&!S.pick&&!S.detPick&&!S.infoPlace&&!S.pickInfo&&!S.swapMode&&!S.labelMode){el.onclick=()=>youOwnSelect(i);if(S.ownSel===i)el.classList.add('sel');}
      }else{
        if(S.sel&&S.sel.pi===pi&&S.sel.i===i)el.classList.add('sel');
        if(S.detMode&&S.detSel.some(function(x){return x.pi===pi&&x.i===i;}))el.classList.add('sel');
        if(S.labelMode&&S.labelSel.some(function(x){return x.pi===pi&&x.i===i;}))el.classList.add('sel');
        if(S.turn===0&&!S.over&&!t.cut&&!t.done)el.onclick=()=>youCutSelect(pi,i);
      }
      el.insertAdjacentHTML('beforeend','<span class="lt">'+L(i)+'</span>');tw.appendChild(el);
      if(t.relRight)pendRel=t.relRight;
    });
    seat.appendChild(tw);hw.appendChild(seat);
  });
  // equip
  const ew=g('equip');ew.innerHTML='';
  if(S.equip.length===0){ew.innerHTML='<div class="muted">装備なし</div>';}
  else{const er=document.createElement('div');er.className='btnrow';S.equip.forEach((e,i)=>{var locked=(e.kind==='himitsu')?(S.yCut<=0):(cutBlue(e.num)<2);const b=document.createElement('button');b.className=(e.used||locked)?'ghost':'sec';b.style.minWidth='150px';b.textContent=((e.kind==='himitsu')?e.name:('['+e.num+'] '+e.name))+(e.used?' ✓':(locked?' 🔒':''));b.disabled=e.used||locked;b.title=locked?((e.kind==='himitsu')?'黄コードを切断すると解放':('数字'+e.num+'のペアが切られると解放')):'';b.onclick=()=>useEquip(i);er.appendChild(b);});ew.appendChild(er);}
}
function revealAll(){if(!confirm('全プレイヤーの手札を公開しますか？'))return;S.showAll=true;pushLog('全員の手札を公開しました（答え合わせ）。','me');render();}
function newGame(){if(confirm('新しい卓を配り直しますか？')){g('board').classList.add('hidden');g('setupCard').classList.remove('hidden');}}
function saveGame(flash){if(!S)return;try{localStorage.setItem('bb_solo4',JSON.stringify(S));if(flash){const m=g('savemsg');m.textContent='保存しました';setTimeout(()=>m.textContent='',2000);}}catch(e){}}
function loadSaved(){try{const raw=localStorage.getItem('bb_solo4');if(!raw){alert('保存データなし');return;}S=JSON.parse(raw);g('setupCard').classList.add('hidden');g('board').classList.remove('hidden');render();if(S.infoPhase){runInfoPhase();}else{S._pending=(!S.over&&S.turn!==0)?decideMove(S.turn):null;scheduleAuto();}}catch(e){alert('読み込み失敗');}}

/* ===== end client game logic ===== */

/* ---------- room-oriented server API ---------- */
function createGame(opts){
  // opts: { names:[seat0,seat1,...], mission:'4'|'8'|'9', pcount:4|5 }
  var names = opts.names || ['P1','P2','P3','P4'];
  var pcount = opts.pcount || names.length;
  __inputs.myName = names[0] || 'P1';
  __inputs.mission = opts.mission || '4';
  __inputs.aiStyle = opts.aiStyle || 'std';
  __inputs.pcount = String(pcount);
  deal();                                  // builds module-global S
  names.forEach(function(nm,i){ if(S.players[i]) S.players[i].name = nm; });
  // clear any partial reveal from deal()'s client-style info step, then start a clean server info phase
  S.players.forEach(function(p){ p.tiles.forEach(function(t){ t.revealed=false; }); });
  S.infoPhase=true; S.infoIdx=0; S.pickInfo=false; S.detPick=null; S.infoPlace=null;
  return S;
}
function finishInfoPhase(){
  S.infoPhase=false; S.pickInfo=false; S.infoIdx=(S.order?S.order.length:0);
  (S.order||[]).forEach(function(pi){
    var P=S.players[pi], c=[];
    P.tiles.forEach(function(t,i){ if(t.t==='B'&&!t.revealed&&!t.cut&&!t.done) c.push(i); });
    if(c.length) P.tiles[c[Math.floor(Math.random()*c.length)]].revealed = true;
  });
  S.turn = S.captain;
}
// drive the initial info-token phase: AI seats auto-place, stop at a human seat
function serverInfoStep(humanSeats){
  S.humanSeats=humanSeats;
  while(true){
    if(S.infoIdx>=S.order.length){ S.infoPhase=false; S.pickInfo=false; S.turn=S.captain; break; }
    var pi=S.order[S.infoIdx];
    if(humanSeats.indexOf(pi)>=0){ S.turn=pi; S.pickInfo=true; return; }
    var P=S.players[pi], c=[];
    P.tiles.forEach(function(t,i){ if(t.t==='B'&&!t.revealed&&!t.cut&&!t.done) c.push(i); });
    if(c.length) P.tiles[c[Math.floor(Math.random()*c.length)]].revealed=true;
    S.infoIdx++;
  }
  stepAI(humanSeats);
}
function serverAdvance(){
  advanceTurn();
  if(S.prio && S.players[S.turn].tiles.some(function(t){return !t.cut&&!t.done;}) && !prioCanAct(S.turn)){
    S.over='lose';
  }
  if((S.passStreak||0) >= 2*Math.max(1,activePlayerCount())){
    S.over='lose'; pushLog('全員が安全に動けず手詰まり → 解除失敗。','bad'); bumpSkill();
  }
}
// If a paused state (miss-info placement / own-cut choice / info-phase placement)
// belongs to a seat that is no longer an active human (disconnected), resolve it
// automatically so the game never stalls waiting on someone who left.
function autoResolvePauses(humanSeats){
  var changed=true, guard=0;
  while(changed && guard++<50){
    changed=false;
    if(S.infoPlace && humanSeats.indexOf(S.infoPlace.seat)<0){
      var DP=S.players[S.infoPlace.seat];
      var opt=(S.infoPlace.opts&&S.infoPlace.opts.length)?S.infoPlace.opts[0]:null;
      if(opt!=null){ DP.tiles[opt].revealed=true; }
      else{ var nr=DP.tiles.find(function(t){return t.t!=='R'&&!t.cut&&!t.done&&!t.revealed;}); if(nr) nr.revealed=true; }
      S.infoPlace=null; checkEnd(); changed=true;
    }
    if(S.detPick && S.detPick.seat!=null && humanSeats.indexOf(S.detPick.seat)<0){
      var act=S.players[S.detPick.seat];
      var ci=act.tiles.findIndex(function(t){return !t.cut&&!t.done&&((S.detPick.hitVal==='Y')?t.t==='Y':(t.t==='B'&&t.n===S.detPick.hitVal));});
      if(ci>=0){ act.tiles[ci].cut=true; if(S.detPick.hitVal==='Y') S.yCut+=2; }
      recomputeCuts(); S.detPick=null; checkEnd(); changed=true;
    }
    if(S.infoPhase && S.pickInfo && humanSeats.indexOf(S.turn)<0){
      var P=S.players[S.turn], c=[];
      P.tiles.forEach(function(t,i){ if(t.t==='B'&&!t.revealed&&!t.cut&&!t.done) c.push(i); });
      if(c.length) P.tiles[c[Math.floor(Math.random()*c.length)]].revealed=true;
      S.pickInfo=false; S.infoIdx++; serverInfoStep(humanSeats); changed=true;
    }
  }
}
// auto-play every AI seat until it is a human seat's turn (or game over)
function stepAI(humanSeats){
  S.humanSeats=humanSeats;
  autoResolvePauses(humanSeats);
  if(S.infoPhase) return;     // info phase is driven by serverInfoStep
  var guard=0;
  while(!S.over && humanSeats.indexOf(S.turn)<0 && guard++<300){
    if(S.infoPlace||S.detPick) return;   // pending for an active human -> pause
    var mv=decideMove(S.turn); resolveMove(mv,S.turn); checkEnd();
    autoResolvePauses(humanSeats);
    if(S.infoPlace||S.detPick) return;   // newly created, belongs to active human -> pause
    if(S.over) break;
    serverAdvance();
  }
}
// apply a human seat's move (mv uses the same shape resolveMove understands)
function applyMove(seat, mv, humanSeats){
  S.humanSeats=humanSeats;
  if(mv && mv.kind==='detPick'){
    if(!S.detPick || S.detPick.seat!==seat) return {ok:false, err:'今は選択のタイミングではありません'};
    var dt=S.players[seat].tiles[mv.idx];
    var dok=(S.detPick.hitVal==='Y')?(dt&&dt.t==='Y'&&!dt.cut&&!dt.done):(dt&&dt.t==='B'&&dt.n===S.detPick.hitVal&&!dt.cut&&!dt.done);
    if(!dok) return {ok:false, err:'切る自分のコードを選んでください'};
    dt.cut=true; if(S.detPick.hitVal==='Y') S.yCut+=2; else clearHold(seat,S.detPick.hitVal); recomputeCuts(); S.detPick=null; checkEnd();
    if(!S.over) serverAdvance(); stepAI(S.humanSeats); return {ok:true};
  }
  if(mv && mv.kind==='placeMissInfo'){
    if(!S.infoPlace || S.infoPlace.seat!==seat) return {ok:false, err:'今は配置のタイミングではありません'};
    if(S.infoPlace.opts.indexOf(mv.idx)<0) return {ok:false, err:'対象のコードを選んでください'};
    var mt=S.players[seat].tiles[mv.idx];
    if(!mt || mt.cut || mt.done || mt.revealed) return {ok:false, err:'置けません'};
    mt.revealed=true; S.infoPlace=null;
    if(!S.over) serverAdvance();
    stepAI(humanSeats); return {ok:true};
  }
  if(mv && mv.kind==='useEquip') return applyEquip(seat, mv.ei, mv.params||{}, humanSeats);
  if(mv && mv.kind==='placeInfo'){
    if(!(S.infoPhase && S.pickInfo && S.turn===seat)) return {ok:false, err:'今は配置のタイミングではありません'};
    var pt=S.players[seat].tiles[mv.idx];
    if(!pt || pt.t!=='B' || pt.cut || pt.done || pt.revealed) return {ok:false, err:'自分の青コードを選んでください'};
    pt.revealed=true; S.pickInfo=false; S.infoIdx++; serverInfoStep(humanSeats); return {ok:true};
  }
  if(mv && mv.kind==='revealAllRed'){
    if(S.over) return {ok:false, err:'game over'};
    if(S.turn!==seat) return {ok:false, err:'not your turn'};
    if(humanSeats.indexOf(seat)<0) return {ok:false, err:'not a human seat'};
    var ract=S.players[seat].tiles.filter(function(t){return !t.cut&&!t.done;});
    if(!ract.length || !ract.every(function(t){return t.t==='R';})) return {ok:false, err:'赤の公開は手札が赤のみのときだけできます'};
    resolveMove(mv, seat); checkEnd();
    if(!S.over) serverAdvance(); stepAI(humanSeats); return {ok:true};
  }
  if(S.over) return {ok:false, err:'game over'};
  if(S.turn!==seat) return {ok:false, err:'not your turn'};
  if(humanSeats.indexOf(seat)<0) return {ok:false, err:'not a human seat'};
  // basic legality
  if((mv.kind==='guess'||mv.kind==='solo'||mv.kind==='detector') && typeof mv.n==='number' && prioLocked(mv.n))
    return {ok:false, err:'number locked by priority'};
  if(mv.kind==='detector'){var _DPx=S.players[mv.targetPi];if(_DPx&&((_DPx.tiles[mv.i1]&&_DPx.tiles[mv.i1].xcode)||(_DPx.tiles[mv.i2]&&_DPx.tiles[mv.i2].xcode)))return {ok:false,err:'Xコードは探知機の対象にできません'};}
  if(mv.kind==='solo'){
    var c=S.players[seat].tiles.filter(function(t){return t.t==='B'&&t.n===mv.n&&!t.cut&&!t.done;}).length;
    if(!(c>=2 && c===(4-cutBlue(mv.n)))) return {ok:false, err:'solo not allowed'};
  }
  resolveMove(mv, seat); checkEnd();
  if(S.infoPlace||S.detPick) return {ok:true};   // wait for human placement / own-code choice
  if(!S.over) serverAdvance();
  stepAI(humanSeats);
  return {ok:true};
}
// apply an equipment card for a human seat (params depend on the kind)
function applyEquip(seat, ei, params, humanSeats){
  params = params || {};
  S.humanSeats=humanSeats;
  if(S.over) return {ok:false,err:'game over'};
  if(S.infoPhase) return {ok:false,err:'準備中は使えません'};
  var e=S.equip[ei]; if(!e) return {ok:false,err:'装備が見つかりません'};
  // 「いつでも使える」装備は他人の手番でも使用できる（実物カード準拠）
  // ラベル2種・ヒント付箋・イレカエシーバー・失敗帳消し機・非常電池・なんでもレーダー
  var ANYTIME=['kotonal','equal','reveal','swap','life','battery','radar'];
  if(S.turn!==seat && ANYTIME.indexOf(e.kind)<0) return {ok:false,err:'あなたの手番に使ってください'};
  if(e.used) return {ok:false,err:'使用済みです'};
  if(e.kind==='himitsu'){ if(S.yCut<=0) return {ok:false,err:'ヒミツ底は黄コードを切断すると使えます'}; }
  else { if(cutBlue(e.num)<2) return {ok:false,err:'対応する数字のペアが切られると使えます'}; }
  var me=S.players[seat];
  var advance=false;       // detector equips end the turn
  function mateOK(i){ return i>=0 && i<S.players.length && i!==seat; }
  switch(e.kind){
    case 'life': S.lives=S.lives+1; e.used=true; pushLog('<b>'+me.name+'</b>：「'+e.name+'」で残機+1。','ok'); break;
    case 'ice': S.iceShield=true; e.used=true; pushLog('<b>'+me.name+'</b>：「'+e.name+'」でこの手番の失敗ペナルティを無効化。','ok'); break;
    case 'himitsu': {
      var pool=[1,2,3,4,5,6,7,8,9,10,11,12].filter(function(id){return !S.equip.some(function(x){return x.num===id;});});
      if(pool.length<2) return {ok:false,err:'追加できる装備が残っていません'};
      var add=[]; for(var a=0;a<2&&pool.length;a++) add.push(pool.splice(Math.floor(Math.random()*pool.length),1)[0]);
      add.forEach(function(id){ S.equip.push({id:id,name:EQUIP[id].name,kind:EQUIP[id].kind,used:false,num:id}); });
      S.equip.sort(function(x,y){return x.num-y.num;}); e.used=true;
      pushLog('<b>'+me.name+'</b>：「ヒミツ底」で「'+add.map(function(id){return EQUIP[id].name;}).join('」「')+'」を追加。','ok'); break;
    }
    case 'reveal': {
      var ft=null;
      if(params.idx!=null){ var _ri=parseInt(params.idx); var _rc=me.tiles[_ri]; if(_rc&&_rc.t==='B'&&!_rc.cut&&!_rc.done&&!_rc.revealed&&!_rc.xcode) ft=_rc; }
      else { var rn=parseInt(params.n); ft=me.tiles.find(function(t){return t.t==='B'&&t.n===rn&&!t.cut&&!t.done&&!t.revealed&&!t.xcode;}); }
      if(!ft) return {ok:false,err:'公開できる自分の青コードを選んでください'};
      ft.revealed=true; e.used=true; pushLog('<b>'+me.name+'</b>：「'+e.name+'」で自分の '+ft.n+' を公開（ヒント）。','ok'); break;
    }
    case 'extra': {
      var ep=parseInt(params.target); if(!mateOK(ep)) return {ok:false,err:'自分以外のプレイヤーを選んでください'};
      e.used=true; S.sel=null; S.iceShield=false; S.turn=ep;
      pushLog('<b>'+me.name+'</b>：「'+e.name+'」→ '+S.players[ep].name+' からゲームを再開。','me');
      checkEnd(); if(!S.over) stepAI(humanSeats); return {ok:true};
    }
    case 'battery': {
      var ts=(params.targets||[]).filter(function(i){return i>=0&&i<S.players.length&&!S.players[i].detector;});
      ts=[...new Set(ts)].slice(0,2); if(ts.length===0) return {ok:false,err:'回復対象（探知機使用済み）を選んでください'};
      ts.forEach(function(i){S.players[i].detector=true;}); e.used=true;
      pushLog('<b>'+me.name+'</b>：「非常電池」→ '+ts.map(function(i){return S.players[i].name;}).join('・')+' の探知機を回復。','ok'); break;
    }
    case 'radar': {
      var dn=parseInt(params.n); var holders=S.players.filter(function(p){return p.tiles.some(function(t){return t.t==='B'&&t.n===dn&&!t.cut&&!t.done&&!t.xcode;});}).map(function(p){return p.name;});
      e.used=true; pushLog('<b>'+me.name+'</b>：「なんでもレーダー」→ '+dn+' を持つのは '+(holders.length?holders.join('・'):'なし')+'。','ok'); break;
    }
    case 'swap': {
      var sp=parseInt(params.target), gi=parseInt(params.give);
      if(!mateOK(sp)) return {ok:false,err:'相手を選んでください'};
      var giveT=me.tiles[gi]; if(!giveT||giveT.cut||giveT.done||giveT.xcode) return {ok:false,err:'渡す自分のコードを選んでください'};
      var TP=S.players[sp]; var cand=TP.tiles.map(function(t,k){return k;}).filter(function(k){return !TP.tiles[k].cut&&!TP.tiles[k].done&&!TP.tiles[k].xcode;});
      if(!cand.length) return {ok:false,err:'相手に渡せるコードがありません'};
      var rk=cand[Math.floor(Math.random()*cand.length)]; var getT=TP.tiles[rk];
      me.tiles.splice(gi,1); TP.tiles.splice(rk,1); TP.tiles.push(giveT); me.tiles.push(getT);
      TP.tiles.sort(function(a,b){return a.val-b.val;}); me.tiles.sort(function(a,b){return a.val-b.val;});
      me.tiles.forEach(function(t){t.relRight=undefined;}); TP.tiles.forEach(function(t){t.relRight=undefined;});
      e.used=true; pushLog('<b>'+me.name+'</b>：「イレカエシーバー」→ '+TP.name+' と1枚ずつ交換。','me'); break;
    }
    case 'kotonal': case 'equal': {
      var tl=params.tiles||[]; if(tl.length!==2) return {ok:false,err:'隣り合う自分の2本を選んでください'};
      var lo=Math.min(tl[0],tl[1]), hi=Math.max(tl[0],tl[1]); if(hi!==lo+1) return {ok:false,err:'隣り合う2本を選んでください'};
      var t1=me.tiles[lo], t2=me.tiles[hi]; if(!t1||!t2) return {ok:false,err:'選択が不正です'};
      if(t1.xcode||t2.xcode) return {ok:false,err:'Xコードにはラベルを使えません'};
      function mvv(t){return t.t==='B'?('N'+t.n):(t.t==='Y'?'Y':('R'+t.n));}
      var same=(t1.t!=='R'&&t2.t!=='R'&&mvv(t1)===mvv(t2)); var wantSame=(e.kind==='equal');
      if(same!==wantSame) return {ok:false,err:wantSame?'この2本は同じ数字ではありません':'この2本は同じ数字です'};
      me.tiles[lo].relRight=wantSame?'=':'\u2260'; e.used=true;
      pushLog('<b>'+me.name+'</b>：「'+e.name+'」→ '+me.name+' の'+L(lo)+'・'+L(hi)+'は '+(wantSame?'＝':'≠')+'。','me'); break;
    }
    case 'super': {
      var up=parseInt(params.target), un=parseInt(params.n);
      if(!mateOK(up)) return {ok:false,err:'対象を選んでください'};
      if(isNaN(un)||un<1||un>12) return {ok:false,err:'数値(1-12)を指定してください'};
      if(!me.tiles.some(function(t){return t.t==='B'&&t.n===un&&!t.cut&&!t.done;})) return {ok:false,err:'合わせる'+un+'が自分にありません'};
      var DP=S.players[up]; var sidx=[]; DP.tiles.forEach(function(t,ii){if(!t.cut&&!t.done&&!t.xcode)sidx.push(ii);});
      detectorResolve(seat, up, sidx, [un]); e.used=true; advance=true; break;
    }
    case 'mitsu': case 'dochi': {
      var dp=parseInt(params.targetPi); var idxs=params.idxs||[]; var decls=params.decls||[];
      var need=(e.kind==='mitsu')?3:1; var ndec=(e.kind==='mitsu')?1:2;
      if(!mateOK(dp)) return {ok:false,err:'対象を選んでください'};
      if(idxs.length!==need) return {ok:false,err:'相手のコードを'+need+'本選んでください'};
      if(idxs.some(function(ii){var tt=S.players[dp].tiles[ii];return tt&&tt.xcode;})) return {ok:false,err:'Xコードは探知機の対象にできません'};
      if(decls.length!==ndec) return {ok:false,err:'数値を'+ndec+'個宣言してください'};
      // must hold each declared value
      for(var di=0; di<decls.length; di++){ var dv=decls[di];
        var hold = dv==='Y' ? me.tiles.some(function(t){return t.t==='Y'&&!t.cut&&!t.done;}) : me.tiles.some(function(t){return t.t==='B'&&t.n===dv&&!t.cut&&!t.done;});
        if(!hold) return {ok:false,err:'合わせる'+(dv==='Y'?'黄':dv)+'が自分にありません'};
      }
      detectorResolve(seat, dp, idxs, decls); e.used=true; advance=true; break;
    }
    default: e.used=true; pushLog('<b>'+me.name+'</b>：「'+e.name+'」を使用。','ok'); break;
  }
  checkEnd();
  if(advance){ if(S.infoPlace||S.detPick) return {ok:true}; if(!S.over) serverAdvance(); stepAI(humanSeats); }
  return {ok:true};
}

// per-seat masked view (others' un-revealed tiles are hidden)
function viewFor(seat){
  return {
    over:S.over, turn:S.turn, captain:S.captain, order:S.order,
    infoPhase:!!S.infoPhase, youPlaceInfo:!!(S.infoPhase&&S.pickInfo&&S.turn===seat),
    youPlaceMissInfo:!!(S.infoPlace&&S.infoPlace.seat===seat), missOpts:(S.infoPlace&&S.infoPlace.seat===seat)?S.infoPlace.opts:null, missInfoPending:!!S.infoPlace, missInfoName:S.infoPlace?S.players[S.infoPlace.seat].name:null,
    youDetPick:!!(S.detPick&&S.detPick.seat===seat), detPickVal:(S.detPick&&S.detPick.seat===seat)?S.detPick.hitVal:null, detPickPending:!!S.detPick, detPickName:S.detPick?S.players[S.detPick.seat].name:null,
    lives:S.lives, maxLives:S.maxLives, reds:S.reds, redDone:S.redDone,
    yCut:S.yCut, mission:S.mission, dangerNum:S.dangerNum||null, prio:S.prio?{nums:S.prio.nums,ptr:S.prio.ptr,thr:S.prio.thr||2}:null,
    cut:S.cut,
    marks:(function(){var ym=[],rm=[];S.players.forEach(function(p){p.tiles.forEach(function(t){if(t.t==='Y')ym.push({n:t.n,cut:!!(t.cut||t.done)});if(t.t==='R')rm.push({n:t.n,done:!!t.done});});});return {yellows:ym,reds:rm,redUncertain:S.redUncertain,redCandidates:S.redCandidates,yellowUncertain:S.yellowUncertain,yellowCandidates:S.yellowCandidates};})(),
    equip:(S.equip||[]).map(function(e){return {num:e.num,name:e.name,kind:e.kind,used:e.used};}),
    log:(S.log||[]).slice(0,60),
    players:S.players.map(function(p,pi){
      return {
        name:p.name, detector:p.detector,
        tiles:p.tiles.map(function(t){
          var shown = (pi===seat) || t.revealed || t.cut || t.done;
          if(shown) return {t:t.t,n:t.n,val:t.val,cut:t.cut,done:t.done,revealed:t.revealed,danger:!!t.danger,xcode:!!t.xcode,relRight:t.relRight||null};
          return {masked:true, cut:t.cut, done:t.done, xcode:!!t.xcode};
        })
      };
    })
  };
}
function getState(){ return S; }
function setState(st){ S = st; }

if (typeof module!=='undefined' && module.exports){
  module.exports = { createGame, viewFor, applyMove, applyEquip, stepAI, serverAdvance, serverInfoStep, getState, setState, finishInfoPhase };
}

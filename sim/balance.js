/*
 * バランス検証スクリプト（node のみ。npmパッケージ不要）
 *
 *   node sim/balance.js [試合数] [検証するHTMLのパス]
 *
 * index.html の <script> をそのまま vm で読み込み、最小限のDOMスタブを与えて
 * 両チームをCPU思考で動かす。ゲームのロジックには一切手を入れていないので、
 * 出てくる数値は「実際に画面で遊んだときの挙動」と同じものになる。
 *
 * 出力：シュート到達率 / ノーマーク率 / 1攻撃あたり期待得点 / 1攻撃あたりシュート本数
 */
const fs=require('fs'), vm=require('vm'), path=require('path');

/* ---------- 最小DOMスタブ ---------- */
function makeEl(){
  const cls=new Set();
  return {
    className:'', textContent:'', innerHTML:'', disabled:false, onclick:null,
    style:{}, dataset:{}, children:[],
    classList:{
      add:c=>cls.add(c), remove:c=>cls.delete(c), contains:c=>cls.has(c),
      toggle:(c,on)=>{ (on===undefined? (cls.has(c)?cls.delete(c):cls.add(c)) : (on?cls.add(c):cls.delete(c))); }
    },
    appendChild(n){ this.children.push(n); return n; }
  };
}
function makeDoc(){
  const byId={};
  return {
    getElementById:id=>(byId[id]||(byId[id]=makeEl())),
    createElement:()=>makeEl(),
    querySelectorAll:()=>[]            // 設定ラジオは検証に使わない
  };
}

/* ---------- タイマーキュー（待ち時間0で順番に流す） ---------- */
function makeTimers(){
  const q=[];
  return { setTimeout:(fn)=>{ q.push(fn); return q.length; }, drain(limit=100000){
    let n=0; while(q.length&&n++<limit){ q.shift()(); } return n; } };
}

/* ---------- 1つのゲーム環境を作る ---------- */
function boot(htmlPath){
  const html=fs.readFileSync(htmlPath,'utf8');
  const src=html.match(/<script>([\s\S]*)<\/script>/)[1];
  const timers=makeTimers();
  const ctx=vm.createContext({ document:makeDoc(), setTimeout:timers.setTimeout, Math, console });
  vm.runInContext(src,ctx);
  const g=expr=>vm.runInContext(expr,ctx);
  const call=(fn,...args)=>{ ctx.__args=args; return vm.runInContext(fn+'(...__args)',ctx); };
  return {ctx,timers,g,call,run:expr=>vm.runInContext(expr,ctx)};
}

/* ---------- 検証本体 ---------- */
function simulate(games,htmlPath){
  const env=boot(htmlPath);
  const st={possessions:0,withShot:0,shots:0,noMark:0,firstShots:0,firstNoMark:0,points:0,made:0};
  // 赤も青もCPU思考で動かす（人の操作を待たない）
  env.run(`
    isCPUTurn=function(){ return !S.gameOver && !document.getElementById('mask').classList.contains('on'); };
    __stat={shots:0,noMark:0,points:0,made:0,firstFlag:false};
    const __doShoot=doShoot;
    doShoot=function(){
      const h=holder();
      if(S.passed&&inSA(h)){
        const free=adjDefenders(h).length===0;
        __stat.shots++; if(free)__stat.noMark++;
        if(!__stat.firstFlag){ __stat.firstShots=(__stat.firstShots||0)+1; if(free)__stat.firstNoMark=(__stat.firstNoMark||0)+1; }
        __stat.firstFlag=true;
      }
      return __doShoot.apply(this,arguments);
    };
    const __madeShot=madeShot;
    madeShot=function(team,pts){ __stat.made++; __stat.points+=pts; return __madeShot.apply(this,arguments); };
  `);

  for(let game=0;game<games;game++){
    env.run(`S=initState('A'); S.scoreA=0; S.scoreB=0; S.log=[]; S.attackNo=1; __stat.firstFlag=false; render();`);
    let lastAttack=1, guard=0;
    while(!env.g('S.gameOver') && guard++<200000){
      if(env.g("document.getElementById('mask').classList.contains('on')")){
        // 演出中（spin）にボタンを押すと二重発火するので、そこだけはタイマーを進めて待つ
        if(env.g('mStage')==='spin') env.timers.drain(1);
        else env.run("document.getElementById('mBtn').onclick()");
      } else if(env.timers.drain(1)===0){
        env.run('render()');                     // 手が止まったら描画から回し直す（→maybeCPU）
      }
      const a=env.g('S.attackNo');
      if(a!==lastAttack){                        // 攻撃が切り替わった＝1攻撃ぶん終わった
        st.possessions++; if(env.g('__stat.firstFlag')) st.withShot++;
        env.run('__stat.firstFlag=false'); lastAttack=a;
      }
    }
    st.possessions++; if(env.g('__stat.firstFlag')) st.withShot++;
  }
  const s=env.g('JSON.stringify(__stat)') , x=JSON.parse(s);
  st.shots=x.shots; st.noMark=x.noMark; st.firstShots=x.firstShots||0; st.firstNoMark=x.firstNoMark||0;
  st.points=x.points; st.made=x.made;
  return st;
}

const games=Number(process.argv[2]||40);
const htmlPath=process.argv[3]||path.join(__dirname,'..','index.html');
const r=simulate(games,htmlPath);
const pc=(a,b)=>(100*a/Math.max(b,1)).toFixed(0)+'%';
console.log(`${path.basename(htmlPath)} : ${games}試合 / ${r.possessions}攻撃`);
console.log('シュート到達率        :', pc(r.withShot,r.possessions));
console.log('ノーマーク率(最初の1本):', pc(r.firstNoMark,r.firstShots));
console.log('ノーマーク率(全シュート):', pc(r.noMark,r.shots));
console.log('1攻撃あたり期待得点    :', (r.points/Math.max(r.possessions,1)).toFixed(2));
console.log('1攻撃あたりシュート本数:', (r.shots/Math.max(r.possessions,1)).toFixed(1));

"use strict";
// Offline-only calibration. No runtime player-, bet- or history-dependent knobs.
const fs=require("node:fs"),path=require("node:path"),Module=require("node:module");
const {measure,measureBase}=require("./zeusRulesAudit");
const file=path.join(__dirname,"../games/dice/DiceEngine.js");
const profilePath=path.join(__dirname,"../games/dice/zeusEconomyV4.json");
function withProfile(profile) {
  const mod=new Module(file,module);mod.filename=file;mod.paths=Module._nodeModulePaths(path.dirname(file));
  const local=Module.createRequire(file);
  mod.require=id=>id==="./zeusEconomyV4.json" ? profile : local(id);
  mod._compile(fs.readFileSync(file,"utf8"),file);
  return mod.exports;
}
function main() {
  const profile=JSON.parse(fs.readFileSync(profilePath));
  const base=structuredClone(profile.multiplierWeights);
  const selected=process.argv.find(s=>s.startsWith("--mode="))?.slice(7);
  const iterations=Number(process.argv.find(s=>s.startsWith("--iterations="))?.split("=")[1] || 8);
  const rounds=Number(process.argv.find(s=>s.startsWith("--rounds="))?.split("=")[1] || 10000);
  for(const mode of selected ? [selected] : ["bonus","super","base"]) {
    let lo=0,hi=Math.min(5,99/base[mode].reduce((a,b)=>a+b,0)),best=null;
    let strataCache;
    for(let i=0;i<iterations;i++) {
      const factor=(lo+hi)/2;
      profile.multiplierWeights[mode]=base[mode].map(p=>Number((p*factor).toFixed(7)));
      const spinEngine=withProfile(profile);
      const r=mode==="base" ? measureBase({spinEngine,rounds:Math.max(500,Math.floor(rounds/20)),seeds:[317,941,2027],strataCache})
        : measure({mode,spinEngine,version:4,rounds,seeds:[317,941,2027]});
      if(mode==="base") strataCache=r.strata;
      const delta=Math.abs(r.rtp-profile.targets[mode]);
      if(!best || delta<best.delta) best={delta,weights:[...profile.multiplierWeights[mode]],report:r};
      console.log(JSON.stringify({mode,iteration:i,factor,rtp:r.rtp,ci95:r.ci95}));
      if(r.rtp<profile.targets[mode]) lo=factor;else hi=factor;
    }
    profile.multiplierWeights[mode]=best.weights;
    console.log(JSON.stringify({mode,selected:best.weights,rtp:best.report.rtp}));
  }
  if(process.argv.includes("--write")) fs.writeFileSync(profilePath,JSON.stringify(profile,null,2)+"\n");
  else console.log(JSON.stringify(profile,null,2));
}
if(require.main===module) main();
module.exports={withProfile};

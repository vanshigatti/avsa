// propagation/heuristic.js
// Organic flowing layout — not a grid, looks like a real spread map

const FAKE_KEYWORDS = [
  "free","lakh","crore","all citizens","before election","scheme",
  "government giving","viral","leaked","breaking","shocking","exclusive",
  "must share","forward करें","share now","confirmed","urgent","emergency",
  "miracle","banned","they don't want","hidden","secret"
];

function detectLanguage(text) {
  if (/[\u0900-\u097F]/.test(text)) return "Hindi";
  if (/[\u0A80-\u0AFF]/.test(text)) return "Gujarati";
  if (/[\u0B80-\u0BFF]/.test(text)) return "Tamil";
  if (/[\u0C00-\u0C7F]/.test(text)) return "Telugu";
  if (/[\u0980-\u09FF]/.test(text)) return "Bengali";
  return "English";
}
function fakeSignalCount(text) {
  return FAKE_KEYWORDS.filter(k=>text.toLowerCase().includes(k)).length;
}
function fmt(n) {
  if (n>=100000) return (n/100000).toFixed(1)+"L";
  if (n>=1000)   return (n/1000).toFixed(1)+"K";
  return String(n);
}
function shortTitle(t,max=14) {
  if (!t) return "Article";
  return t.length>max?t.slice(0,max)+"…":t;
}
function domainName(u) {
  try{return new URL(u).hostname.replace("www.","");}
  catch{return "unknown";}
}
function classifyOutlet(url="") {
  const s=url.toLowerCase();
  if (/twitter|x\.com/.test(s)) return "twitter";
  if (/facebook/.test(s))       return "facebook";
  if (/telegram/.test(s))       return "telegram";
  if (/youtube/.test(s))        return "youtube";
  return "news";
}

async function analyzeClaimWithGroq(claimText, groqApiKey) {
  if (!groqApiKey) return null;
  const prompt=`You are a misinformation analyst for Indian social media.
Analyze this claim and return ONLY valid JSON.
Claim: "${claimText.slice(0,350)}"
{"claim_category":"health|politics|religion|finance|celebrity|science|other","origin_type":"unknown blog|WhatsApp forward|satire site|fabricated screenshot|other","primary_spread_platform":"whatsapp|twitter|facebook|telegram","fact_check_outlets":["outlet1","outlet2"],"search_query":"3-5 word query","spread_pattern":"viral|moderate|low","why_spreads":"one sentence","estimated_reach":"high|medium|low"}
Pick fact_check_outlets from: AltNews, BoomLive, NewsMobile, FactChecker, Vishvas News, NewsChecker, Quint WebQoof, AFP Fact Check, Snopes, PolitiFact`;
  try {
    const res=await fetch("https://api.groq.com/openai/v1/chat/completions",{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":`Bearer ${groqApiKey}`},
      body:JSON.stringify({model:"llama-3.1-8b-instant",messages:[{role:"user",content:prompt}],temperature:0.1,max_tokens:300}),
      signal:AbortSignal.timeout(8000)
    });
    const data=await res.json();
    const content=data?.choices?.[0]?.message?.content||"";
    const match=content.match(/\{[\s\S]*\}/);
    if (match){const p=JSON.parse(match[0]);console.log("Groq:",JSON.stringify(p));return p;}
  } catch(e){console.log("Groq failed:",e.message);}
  return null;
}

async function fetchTavily(searchQuery, claimCategory, tavilyApiKey) {
  if (!tavilyApiKey) return [];
  const fcDomains=["altnews.in","boomlive.in","newschecker.in","thequint.com",
    "vishvasnews.com","factchecker.in","newsmobile.in","snopes.com","factcheck.org","politifact.com"];
  if (claimCategory==="health")   fcDomains.push("who.int","mohfw.gov.in");
  if (claimCategory==="politics") fcDomains.push("ndtv.com","thehindu.com","scroll.in");
  if (claimCategory==="finance")  fcDomains.push("rbi.org.in","economictimes.com");
  try {
    const [r1,r2]=await Promise.allSettled([
      fetch("https://api.tavily.com/search",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({api_key:tavilyApiKey,query:`fact check ${searchQuery}`,search_depth:"advanced",max_results:5,include_domains:fcDomains}),
        signal:AbortSignal.timeout(10000)}),
      fetch("https://api.tavily.com/search",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({api_key:tavilyApiKey,query:`${searchQuery} misinformation India fake`,search_depth:"basic",max_results:5}),
        signal:AbortSignal.timeout(10000)})
    ]);
    const results=[];
    if(r1.status==="fulfilled"){const d=await r1.value.json();results.push(...(d.results||[]));}
    if(r2.status==="fulfilled"){const d=await r2.value.json();results.push(...(d.results||[]));}
    const qw=searchQuery.toLowerCase().split(/\s+/).filter(w=>w.length>3);
    const scored=results.filter(r=>r.url&&r.title).map(r=>{
      const tl=r.title.toLowerCase(),ul=r.url.toLowerCase();
      let s=r.score||0;
      if(fcDomains.some(d=>ul.includes(d)))s+=3;
      qw.forEach(w=>{if(tl.includes(w))s+=1;});
      if(/fact.?check|debunk|false|mislead|fake|hoax/i.test(tl))s+=2;
      return{...r,relevanceScore:s};
    }).sort((a,b)=>b.relevanceScore-a.relevanceScore);
    const seen=new Set(),unique=[];
    for(const r of scored){const d=domainName(r.url);if(!seen.has(d)&&unique.length<2){seen.add(d);unique.push(r);}}
    return unique;
  } catch(e){console.log("Tavily error:",e.message);return[];}
}

function buildNodes(groqAnalysis, tavilyResults, factCheckReviews, text, fakeProbability) {
  const lang    = detectLanguage(text);
  const signals = fakeSignalCount(text);
  const m       = 0.4+(fakeProbability/100)*1.6;

  const originType      = groqAnalysis?.origin_type             || "Unknown source";
  const primaryPlatform = groqAnalysis?.primary_spread_platform || "whatsapp";
  const whySpreads      = groqAnalysis?.why_spreads             || "Contains emotional trigger language";
  const spreadPattern   = groqAnalysis?.spread_pattern          || "moderate";
  const groqOutlets     = groqAnalysis?.fact_check_outlets      || ["AltNews","BoomLive"];
  const pm              = spreadPattern==="viral"?1.4:spreadPattern==="low"?0.5:1.0;
  const fm              = m*pm;

  // ═══════════════════════════════════════════════════════
  // ORGANIC LAYOUT — nodes flow like a real network,
  // not a table. Staggered heights, natural left→right flow.
  //
  // viewBox: 0 0 660 270
  //
  //  Origin(75,135) ──► Twitter(195,65) ──► Article0(390,50) ──► FC0(545,80)
  //                 └──► WhatsApp(195,205)──► Article1(390,220)──► FC1(545,200)
  //                          └──► Telegram(310,135)                   ↓
  //                                                             Reshare(545,135)
  // ═══════════════════════════════════════════════════════

  const platformNodes = [
    {
      id:"origin", label:"Origin\nSource", type:"origin",
      x:75, y:135, r:20, shares:"1 post", time:0,
      detail:`Type: ${originType}\nLanguage: ${lang}\nFake signals: ${signals}\nWhy it spreads: ${whySpreads}`
    },
    {
      id:"twitter", label:"Twitter/X", type:"twitter",
      x:195, y:65, r: primaryPlatform==="twitter"?26:20,
      shares:`~${fmt(Math.round(42000*fm))} est.`, time:1,
      detail:`${primaryPlatform==="twitter"?"⚡ Primary platform\n":""}Estimated — paid API\nFake probability: ${fakeProbability}%`
    },
    {
      id:"whatsapp", label:"WhatsApp", type:"whatsapp",
      x:195, y:205, r: primaryPlatform==="whatsapp"?30:24,
      shares:`~${fmt(Math.round(140000*fm))} est.`, time:1,
      detail:`${primaryPlatform==="whatsapp"?"⚡ Primary platform\n":""}Estimated — no public API\nFake probability: ${fakeProbability}%`
    },
    {
      id:"telegram", label:"Telegram", type:"telegram",
      x:310, y:135, r: primaryPlatform==="telegram"?22:17,
      shares:`~${fmt(Math.round(6200*fm))} est.`, time:2,
      detail:`${primaryPlatform==="telegram"?"⚡ Primary platform\n":""}Estimated channel spread`
    }
  ];

  // Article nodes — staggered, not perfectly aligned
  const tavilyTop = tavilyResults.slice(0,2);
  const artPositions = [{x:390,y:50},{x:390,y:220}];

  const realNewsNodes = tavilyTop.map((art,i)=>{
    const domain=domainName(art.url||"");
    return {
      id:`real_${i}`, label:shortTitle(domain,13),
      type:classifyOutlet(art.url||""), isReal:true, url:art.url||"",
      x:artPositions[i].x, y:artPositions[i].y,
      r:16, shares:"Real article", time:3,
      detail:`${shortTitle(art.title||domain,50)}\nSource: ${domain}\n★ Click to open`
    };
  });

  const groqOutletNodes = realNewsNodes.length===0
    ? groqOutlets.slice(0,2).map((outlet,i)=>({
        id:`groq_outlet_${i}`, label:shortTitle(outlet,13),
        type:"news", isReal:false, url:"",
        x:artPositions[i].x, y:artPositions[i].y,
        r:16, shares:"Likely covered", time:3,
        detail:`${outlet} typically\nfact-checks this claim.\n(Groq-suggested)`
      }))
    : [];

  // Fact-check nodes — staggered heights
  const fcPositions = [{x:510,y:80},{x:510,y:200}];
  const factNodes=(factCheckReviews||[]).slice(0,2).map((r,i)=>({
    id:`fc_${i}`, label:shortTitle(r.publisher||"Fact Check",13),
    type:"news", isReal:true, url:r.url||"",
    x:fcPositions[i].x, y:fcPositions[i].y,
    r:15, shares:r.rating||"Checked", time:4,
    detail:`${shortTitle(r.title||r.claim||"",50)}\nRating: ${r.rating||"—"}\nBy: ${r.publisher||"—"}\n★ Click to open`
  }));

  // Reshare — center-right
    const reshareNode = {
    id:"reshare", label:"Reshare\nWave 2", type:"whatsapp",
    x:640, y:135, r:13,
    shares:`~${fmt(Math.round(32000*fm))} est.`, time:5,
    detail:`Second spread ~48–72h\n${whySpreads}`
  };

  const articleNodes = realNewsNodes.length>0?realNewsNodes:groqOutletNodes;
  const allNodes     = [...platformNodes,...articleNodes,...factNodes,reshareNode];
  const nodeIds      = new Set(allNodes.map(n=>n.id));

  const links = [
    {source:"origin",  target:"twitter",  t:"0→2h", w:primaryPlatform==="twitter"?3.5:1.8},
    {source:"origin",  target:"whatsapp", t:"0→1h", w:primaryPlatform==="whatsapp"?4:2.5},
    {source:"twitter", target:"telegram", t:"3→8h", w:1.5},
    {source:"whatsapp",target:"telegram", t:"2→5h", w:1.5},
  ];

  const artSrc=["twitter","whatsapp"];
  articleNodes.forEach((n,i)=>{
    links.push({source:artSrc[i]||"telegram",target:n.id,t:`${6+i*6}→${12+i*6}h`,w:1.5});
    links.push({source:n.id,target:"reshare",t:"24→72h",w:1});
  });

  factNodes.forEach((n,i)=>{
    const src=articleNodes[i]?.id||artSrc[i]||"telegram";
    if(nodeIds.has(src)) links.push({source:src,target:n.id,t:"12→24h",w:1.5});
    links.push({source:n.id,target:"reshare",t:"24→48h",w:1});
  });

  if (articleNodes.length===0&&factNodes.length===0){
    links.push({source:"twitter", target:"reshare",t:"24→48h",w:1});
    links.push({source:"telegram",target:"reshare",t:"24→72h",w:1});
  }

  const realCount=realNewsNodes.length+factNodes.length;
  return {
    nodes:allNodes,links,language:lang,signals,realCount,
    dataSource:realCount>0
      ?`${realCount} real source(s) from Tavily + Google Fact Check`
      :groqOutletNodes.length>0
        ?"No live articles — Groq suggested likely outlets"
        :"Estimated spread model"
  };
}

async function generatePropagation(text, fakeProbability, options={}) {
  const {tavilyApiKey,groqApiKey,factCheckReviews=[]}=options;
  console.log("=== Propagation ===\nClaim:",text.slice(0,80));
  const groqAnalysis =await analyzeClaimWithGroq(text,groqApiKey);
  const searchQuery  =groqAnalysis?.search_query||text.split(" ").slice(0,5).join(" ");
  const category     =groqAnalysis?.claim_category||"other";
  console.log("Query:",searchQuery,"| Cat:",category);
  const tavilyResults=await fetchTavily(searchQuery,category,tavilyApiKey);
  console.log(`Groq:${groqAnalysis?"✓":"✗"} Tavily:${tavilyResults.length} FC:${factCheckReviews.length}`);
  return buildNodes(groqAnalysis,tavilyResults,factCheckReviews,text,fakeProbability);
}

function generatePropagationSync(text,fakeProbability){
  return buildNodes(null,[],[],text,fakeProbability);
}

module.exports={generatePropagation,generatePropagationSync};
/**
 * The sunset's starfield, carried across from design/family/logout.html with
 * its seeded RNG intact — the same two-layer tiled field the sign-in uses, so
 * the two screens are the same sky at opposite ends of the day (CON-17).
 *
 * Imperative DOM by design: it builds SVG nodes directly. Svelte renders the
 * markup and stands back.
 */
export function mountSunsetSky() {

  (function(){
    var NS='http://www.w3.org/2000/svg';
    function rng(seed){
      var s=seed>>>0;
      return function(){
        s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;
        return s/4294967296;
      };
    }
    function makeLayer(container,cls,count,rMin,rMax,opMin,opMax,fill,twChance,seed){
      var rand=rng(seed);
      var wrap=document.createElementNS(NS,'g');
      wrap.setAttribute('class','drift '+cls);
      for(var copy=0;copy<2;copy++){
        var g=document.createElementNS(NS,'g');
        g.setAttribute('fill',fill);
        if(copy===1) g.setAttribute('transform','translate(1600,0)');
        for(var i=0;i<count;i++){
          var c=document.createElementNS(NS,'circle');
          var x=rand()*1600, y=rand()*1000;
          var r=rMin+rand()*(rMax-rMin);
          var op=opMin+rand()*(opMax-opMin);
          c.setAttribute('cx',x.toFixed(1));
          c.setAttribute('cy',y.toFixed(1));
          c.setAttribute('r',r.toFixed(2));
          c.setAttribute('opacity',op.toFixed(2));
          if(rand()<twChance){
            c.setAttribute('class','tw');
            c.style.animationDelay=(rand()*6).toFixed(1)+'s';
          }
          g.appendChild(c);
        }
        wrap.appendChild(g);
      }
      container.appendChild(wrap);
    }
    var field=document.getElementById('starfield');
    makeLayer(field,'far',120,0.4,0.9,0.1,0.36,'#e9edf8',0.14,7791);
    makeLayer(field,'near',46,0.8,1.7,0.35,0.72,'#f4f0ff',0.25,3057);
  })();
}

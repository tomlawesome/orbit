/*
 * THE FLIGHT'S WORLD, DRAWN IN WEBGL2 (#1253; ported from orbit-site's
 * assets/js/voyage.js at c189d38), beneath the flight's own canvas
 * (engine.js), which keeps the traffic, the bloom and the mark on top.
 *
 * Here: the Earth the door shows as a globe that falls away -- the same
 * camera, 800 km over the Atlantic facing the sunrise over Europe, projected
 * onto whatever circle the flight gives the world each frame, so it moves
 * exactly as the flight's world does while its shading stays true: the
 * cities on the night side, the air lit along the limb, the sunlit crescent
 * opening as the camera climbs. Behind it, the Milky Way and the fine stars;
 * in front, the streaks of the climb, light in depth layers about the way
 * ahead; at the end, the star the flight arrives at. Then the film: bloom,
 * the door's own tone curve, grain.
 *
 * Left out of the site's version: the docs' flight (its galaxy in three
 * dimensions, its 48,000 stars, the constellations lighting at the end). The
 * app has no such flight, and its shaders were a large share of the compile.
 *
 * WITHOUT WEBGL2, or if anything here fails, the flight draws as it always
 * has, on its own canvas (engine.js decides at each flight's start).
 *
 * CREDITS. Earth: NASA's Black Marble city lights (2016) and Blue Marble
 * land and clouds, NASA Earth Observatory
 * (https://earthobservatory.nasa.gov/features/NightLights), reduced to small
 * maps. The gold moon: NASA's CGI Moon Kit (LRO colour, LOLA elevation;
 * NASA's Scientific Visualization Studio), graded to gold. The Milky Way:
 * NASA's Deep Star Maps 2020 (NASA/Goddard Space Flight Center Scientific
 * Visualization Studio), from Gaia DR2 data: ESA/Gaia/DPAC, licensed CC BY-NC
 * 3.0 IGO (https://creativecommons.org/licenses/by-nc/3.0/igo/) -- commercial
 * use of this picture needs ESA's permission. Every picture's credit, as its
 * licence asks for it, is in $lib/about/credits.js.
 */

import { version } from "$app/environment";

import { chore, fetchOnce, note } from "./chores.js";
import { frameCost, gpu, rememberedFit, rememberFit, sayVerdict } from "./fitness.js";

const TEX = {
  lights: "/flight/world/earth-lights.webp",
  day: "/flight/world/earth-day.webp",
  clouds: "/flight/world/earth-clouds.webp",
  euro: "/flight/world/europe-lights.webp",
  moon: "/flight/world/moon.webp",
  /* the Milky Way. Set this to null and the galaxy is drawn instead (SKYPAINT,
     below), exactly as it is when the picture cannot be loaded */
  sky: "/flight/world/galaxy-2k.webp",
};
/** start the flight's pictures down the wire (the network is never a chore) */
export function fetchVoyage() { for (const url of Object.values(TEX)) if (url) fetchOnce(url).catch(() => {}); }
/* the Europe lights cover lon 2..24, lat 38..55: the door's own view, sharper */
const EURO = [2, 24, 38, 55];

const VERT = `#version 300 es
void main(){ vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2); gl_Position=vec4(p*2.0-1.0,0.0,1.0); }`;

const SCENE = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform float uPx, uTime;
uniform vec2 uVP; uniform float uSpeed, uRmax; uniform vec4 uOff, uLen; uniform vec3 uTint;
uniform vec3 uCirc; uniform float uEarthA, uD; uniform mat3 uB; uniform vec3 uSun; uniform vec4 uHas;
uniform sampler2D uLights, uDay, uClouds, uEuro, uSky; uniform vec4 uEuroBox;
uniform mat3 uSkyM; uniform float uStarA, uDens;
uniform float uBloom, uPre; uniform vec2 uBloomPt;
uniform vec4 uMoonS; uniform vec2 uMoonV; uniform float uMoonSpin; uniform sampler2D uMoonT;
uniform float uNeb, uNebOff;
out vec4 o;
const float PI=3.14159265, TAU=6.2831853;
float hash13(vec3 p){p=fract(p*0.1031);p+=dot(p,p.zyx+31.32);return fract((p.x+p.y)*p.z);}
float hash12(vec2 p){return hash13(vec3(p,7.31));}
float vnoise(vec3 p){
  vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash13(i),hash13(i+vec3(1,0,0)),f.x),mix(hash13(i+vec3(0,1,0)),hash13(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash13(i+vec3(0,0,1)),hash13(i+vec3(1,0,1)),f.x),mix(hash13(i+vec3(0,1,1)),hash13(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float fbm3(vec3 p){ float s=0.0,a=0.5; for(int i=0;i<5;i++){ s+=a*vnoise(p); p=p*2.03+vec3(1.7,9.2,3.1); a*=0.5; } return s; }

/* ── the sky ── */
vec3 stars(vec3 d,float f){
  vec3 c=vec3(0.0); float pxA=1.0/f;
  for(int i=0;i<3;i++){
    float fi=float(i), sc=(i==0?24.0:i==1?80.0:240.0);
    vec3 g=d*sc, id=floor(g);
    float h1=hash13(id+fi*31.0), h2=hash13(id.yzx+fi*17.0+5.0), h3=hash13(id.zxy+fi*13.0+11.0);
    vec3 sp=normalize((id+0.3+0.4*vec3(h1,h2,hash13(id+7.0+fi)))/sc);
    float px=acos(clamp(dot(d,sp),-1.0,1.0))/pxA;
    float base=i==0?0.6:i==1?0.55:0.45;
    float keep=step(mix(i==0?0.82:0.97,base,uDens),h3);
    float m=(i==0?0.6+pow(h1,3.0)*6.0:i==1?0.25+pow(h2,3.0)*1.5:0.08+0.3*h2)*keep;
    float tint=fract(h1*13.7+h2*7.1);
    vec3 col=tint<0.25?vec3(0.66,0.76,1.0):tint<0.6?vec3(1.0,0.97,0.94):tint<0.85?vec3(1.0,0.87,0.7):vec3(1.0,0.7,0.52);
    c+=col*m*exp(-px*px*1.6);
  }
  return c;
}
vec3 sky(vec2 css){
  float f=uRes.y/uPx*0.95;
  vec3 d=normalize(vec3((css.x-uRes.x/uPx*0.5)/f,(uRes.y/uPx*0.5-css.y)/f,1.0));
  vec3 s=uSkyM*d;
  vec2 uv=vec2(atan(s.x,s.z)/TAU+0.5,0.5-asin(clamp(s.y,-1.0,1.0))/PI);
  /* the night itself: black, with only the faintest warmth of the galaxy's own light */
  vec3 c=vec3(0.0011,0.0010,0.0010);
  if(uHas.w>0.5) c+=pow(texture(uSky,uv).rgb,vec3(2.2))*0.055;
  c+=stars(s,f*uPx)*0.16*uStarA;
  return c;
}
/* ── the streaks: light passing, in four depths, each a ring of lanes about the way ahead ── */
vec3 streaks(vec2 css){
  vec2 p=css-uVP; float r=length(p); if(r<6.0) return vec3(0.0);
  float a=atan(p.y,p.x), u=log(r);
  vec3 acc=vec3(0.0);
  for(int i=0;i<4;i++){
    float z=0.35+0.22*float(i);
    float N=floor(520.0+520.0*float(i));
    float sct=a/TAU*N, s0=floor(sct);
    float du=0.62, off=uOff[i], len=uLen[i];
    for(int k=0;k<2;k++){
      float s=s0+float(k)-(fract(sct)<0.5?1.0:0.0);
      float hs=hash12(vec2(s,float(i)*7.0));
      float aj=(s+0.5+0.6*(hash12(vec2(s,3.1+float(i)))-0.5))/N*TAU;
      float da=a-aj; da=mod(da+PI,TAU)-PI;
      float perp=abs(da)*r;
      float near=clamp(r/uRmax,0.0,1.0);
      float w=(0.45+1.5*near*z)/uPx*uPx;
      if(perp>w*4.0) continue;
      float uu=u-off-hs*du; float cell=floor(uu/du);
      for(int j=0;j<2;j++){
        float cj=cell+float(j);
        float hc=hash13(vec3(s,cj,float(i)));
        if(hc>0.15*mix(0.12,1.0,uDens)) continue;
        float head=off+hs*du+(cj+hash13(vec3(cj,s,9.0+float(i))))*du;
        float L=max(len,w*1.2/r);
        float along=(u-(head-L))/L;
        if(along<0.0||along>1.0+w/(r*L)) continue;
        float tail=pow(clamp(along,0.0,1.0),1.6);
        float core=exp(-perp*perp/(w*w));
        float tcol=hash13(vec3(s,cj,4.0));
        vec3 col=tcol<0.07?uTint:tcol<0.35?vec3(0.72,0.8,1.0):tcol<0.85?vec3(1.0,0.97,0.93):vec3(1.0,0.86,0.7);
        float hb=hash13(vec3(cj,s,17.0+float(i)));
        float bright=(0.2+1.4*near)*(0.35+0.65*z)*(0.25+2.2*hb*hb*hb*hb);
        col*=mix(vec3(1.18,0.92,0.72),vec3(0.86,0.97,1.2),clamp(along,0.0,1.0)*0.85+0.15);
        acc+=col*core*tail*bright*smoothstep(10.0,60.0,r);
      }
    }
  }
  return acc;
}

/* ── the Earth ── */
float chapman(float X,float h,float c){
  float cc=sqrt(X+h), ce=cc*exp(-h);
  if(c>=0.0) return ce/(cc*c+1.0);
  float x0=sqrt(1.0-c*c)*(X+h), c0=sqrt(x0);
  return 2.0*c0*exp(X-x0)-ce/(1.0-cc*c);
}
const vec3 BR=vec3(36.95,86.38,210.9);      /* Rayleigh, per Earth radius */
const float HR=8.0/6371.0, BM=25.46, BMX=28.0, HM=1.2/6371.0, RA=1.0+100.0/6371.0;
const vec3 BO=vec3(0.650,1.881,0.085)*6371.0e-3*0.6;
const vec3 SUNL=vec3(1.0,0.96,0.90)*20.0;
vec3 tauSun(float hh,float mu){
  /* the Earth in the way: no sun */
  float hz=-sqrt(max(0.0,1.0-1.0/((1.0+hh)*(1.0+hh))));
  if(mu<hz) return vec3(1e4);
  return BR*HR*chapman(1.0/HR,hh/HR,mu)+BMX*HM*chapman(1.0/HM,hh/HM,mu)+BO*0.012*chapman(1.0/(15.0/6371.0),max(hh-0.0039,0.0)/(15.0/6371.0),mu);
}
vec2 sph(vec3 ro,vec3 rd,float R){ float b=dot(ro,rd), c=dot(ro,ro)-R*R, d=b*b-c; if(d<0.0) return vec2(-1.0); d=sqrt(d); return vec2(-b-d,-b+d); }
vec3 surface(vec3 P,vec3 rd,out float ca){
  float lat=asin(clamp(P.z,-1.0,1.0)), lon=atan(P.y,P.x);
  vec2 uv=vec2(lon/TAU+0.5,0.5-lat/PI);
  float mu=dot(P,uSun);
  vec3 lights=uHas.x>0.5?pow(texture(uLights,uv).rgb,vec3(2.2)):vec3(0.0);
  float dlat=degrees(lat), dlon=degrees(lon);
  if(uHas.y>0.5&&dlon>uEuroBox.x&&dlon<uEuroBox.y&&dlat>uEuroBox.z&&dlat<uEuroBox.w){
    vec2 eu=vec2((dlon-uEuroBox.x)/(uEuroBox.y-uEuroBox.x),(uEuroBox.w-dlat)/(uEuroBox.w-uEuroBox.z));
    float edge=min(min(eu.x,1.0-eu.x),min(eu.y,1.0-eu.y));
    lights=mix(lights,pow(texture(uEuro,eu).rgb,vec3(2.2)),smoothstep(0.0,0.06,edge));
  }
  float cl=uHas.z>0.5?texture(uClouds,uv).r:0.0; ca=smoothstep(0.22,0.85,cl);
  vec3 alb=uHas.z>0.5?pow(texture(uDay,uv).rgb,vec3(2.2)):vec3(0.06,0.07,0.1);
  /* the sun on the ground and on the cloud tops, through the air above them */
  vec3 Ts=exp(-tauSun(0.0,mu)), Tc=exp(-tauSun(8.0/6371.0,mu));
  float lit=smoothstep(-0.02,0.06,mu)*max(mu,0.0)+0.02*smoothstep(-0.05,0.02,mu);
  float clit=smoothstep(-0.04,0.05,mu)*max(mu+0.03,0.0);
  /* the twilight sky's own light, and a little moonlight */
  vec3 tw=vec3(0.25,0.35,0.7)*0.35*exp(min(mu,0.0)*28.0)*step(mu,0.15)+vec3(0.55,0.62,0.78)*0.018;
  vec3 ground=alb*(SUNL*0.4*Ts*lit/PI+tw);
  vec3 cloud=vec3(0.85)*(SUNL*0.3*Tc*clit/PI+tw*1.3);
  float night=1.0-smoothstep(-0.12,0.02,mu);
  vec3 c=mix(ground,cloud,ca)+lights*0.9*night*(1.0-0.8*ca)+lights*0.12*night*ca;
  return c;
}
vec3 earth(vec2 css,out float cover){
  cover=0.0;
  vec2 d=vec2(css.x-uCirc.x,uCirc.y-css.y)/uCirc.z;
  float F=sqrt(uD*uD-1.0);
  vec3 rd=normalize(uB*vec3(d.x,d.y,F)), ro=-uB[2]*uD;
  vec3 L=vec3(0.0), T=vec3(1.0);
  vec2 ta=sph(ro,rd,RA), tg=sph(ro,rd,1.0);
  bool ground=tg.x>0.0;
  float t1=ground?tg.x:ta.y;
  if(ta.y>0.0){
    float t0=max(ta.x,0.0);
    const int N=16; float ds=(t1-t0)/float(N);
    float j=0.5+0.6*(hash13(vec3(gl_FragCoord.xy,uTime*31.0))-0.5);
    float mv=dot(rd,uSun), pr=3.0/(16.0*PI)*(1.0+mv*mv), g=0.8, pm=(1.0-g*g)/(4.0*PI*pow(1.0+g*g-2.0*g*mv,1.5));
    for(int i=0;i<N;i++){
      vec3 x=ro+rd*(t0+ds*(float(i)+j)); float r=length(x), hh=r-1.0;
      float dr=exp(-hh/HR), dm=exp(-hh/HM);
      vec3 ext=BR*dr+BMX*dm;
      vec3 Tsun=exp(-tauSun(hh,dot(x/r,uSun)));
      vec3 ins=(BR*dr*pr+BM*dm*pm)*Tsun*SUNL+BR*dr*SUNL*0.012*exp(min(dot(x/r,uSun),0.0)*38.0);
      vec3 st=exp(-ext*ds);
      L+=T*ins*(1.0-st)/max(ext,vec3(1e-6)); T*=st;
    }
  }
  if(ground){
    float ca; vec3 P=ro+rd*tg.x;
    L+=T*surface(P,rd,ca);
    /* the edge of the disc, smoothed over a pixel */
    cover=clamp((1.0-length(d))*uCirc.z*uPx+0.5,0.0,1.0);
  }
  /* (the sun itself is the flight's own glow, which matches the door's; this lens would stretch it) */
  return L;
}

/* ── the passage: a nebula streaming past, two depths of it about the way ahead ── */
vec3 nebula(vec2 css,out float dust){
  dust=0.0; if(uNeb<=0.001) return vec3(0.0);
  vec2 p=css-uVP; float r=length(p), a=atan(p.y,p.x), u=log(max(r,1.0));
  vec3 acc=vec3(0.0);
  for(int i=0;i<2;i++){
    float k=i==0?1.5:3.1, sp=i==0?1.0:0.62;
    vec3 q=vec3(cos(a)*k,sin(a)*k,(u-uNebOff*sp)*k*0.85+float(i)*13.0);
    float f=fbm3(q);
    /* filaments: the gas drawn out in threads; knots where it is densest; lanes of dust between */
    float fil=1.0-abs(2.0*vnoise(q*vec3(2.6,2.6,1.3)+3.0)-1.0); fil=fil*fil*fil;
    float d=smoothstep(0.44,0.82,f)*(0.35+0.65*fil);
    float knot=pow(smoothstep(0.62,0.95,f),3.0);
    float lane=smoothstep(0.5,0.75,vnoise(q*vec3(1.8,1.8,0.9)+11.0))*smoothstep(0.35,0.6,f);
    float hue=vnoise(q*0.45+5.0);
    vec3 col=mix(mix(vec3(0.42,0.16,1.0),vec3(1.0,0.22,0.52),smoothstep(0.3,0.68,hue)),vec3(0.16,0.58,0.86),smoothstep(0.66,0.9,hue));
    float near=smoothstep(40.0,uRmax*0.45,r);
    acc+=(col*d*1.2+vec3(1.0,0.86,0.9)*knot*1.6)*(0.3+0.9*near)*(i==0?1.0:0.55)*(1.0-lane*0.8);
    dust+=(d*0.25+lane*0.55)*near;
  }
  dust=clamp(dust*uNeb,0.0,0.7); return acc*uNeb*1.1;
}

/* ── the moon passed on the way out: the install's gold moon, growing as it sweeps by ── */
vec4 moonAt(vec2 css,float lod){
  vec2 d=(css-uMoonS.xy)/uMoonS.z; float rr=dot(d,d); if(rr>1.0) return vec4(0.0);
  vec3 n=vec3(d.x,-d.y,sqrt(1.0-rr));
  float cs=cos(uMoonSpin), sn=sin(uMoonSpin); vec3 m=vec3(cs*n.x+sn*n.z,n.y,-sn*n.x+cs*n.z);
  vec2 uv=vec2(atan(m.x,m.z)/TAU+0.5,0.5-asin(clamp(m.y,-1.0,1.0))/PI);
  vec3 alb=pow(textureLod(uMoonT,uv,lod).rgb,vec3(2.2)); float l=dot(alb,vec3(0.2126,0.7152,0.0722)); alb=mix(vec3(l),alb,0.5);
  vec3 L=normalize(vec3(-0.25,-0.8,-0.15));
  float lit=smoothstep(-0.05,0.25,dot(n,L))*max(dot(n,L),0.0);
  vec3 c=alb*SUNL*lit*0.7+alb*0.006;
  float cov=clamp((1.0-sqrt(rr))*uMoonS.z*uPx+0.5,0.0,1.0);
  return vec4(c*cov,cov);
}
vec4 moon(vec2 css){
  if(uMoonS.w<=0.0||length(css-uMoonS.xy)>uMoonS.z+length(uMoonV)+2.0) return vec4(0.0);
  vec4 acc=vec4(0.0);
  /* its blur over the exposure: twelve fixed steps, so the edges are steady frame to frame. Its map is read at one
     level of detail for the whole disc (its texels across a pixel, at the centre), worked out once here: a read that
     found its own level from its neighbours would have the compiler copy the loop out twelve times over */
  float lod=log2(max(1.0,float(textureSize(uMoonT,0).x)/(TAU*uMoonS.z*uPx)));
  for(int i=0;i<12;i++) acc+=moonAt(css+uMoonV*((float(i)+0.5)/12.0-0.5),lod);
  return acc/12.0*uMoonS.w;
}

/* ── the star at the end: seen ahead as the flight brakes, then blooming ──
   Built as a star is seen through a lens: a limb-darkened photosphere with its granulation and a red chromosphere at
   the rim; a corona of streamers drifting outwards; the ciliary glare, hundreds of hair-fine rays fringed with colour;
   six diffraction spikes, banded along their length, the red reaching furthest; a level anamorphic streak; a faint
   rainbow halo. All of it HDR, so the film's bloom carries it. */
vec3 arrival(vec2 css){
  float e=pow(uBloom,1.2), lum=e+uPre*0.3;
  if(lum<=0.001) return vec3(0.0);
  vec2 p=css-uBloomPt; float r=length(p), H=uRes.y/uPx, Wd=uRes.x/uPx, a=atan(p.y,p.x);
  vec2 dir=r>0.0?p/r:vec2(1.0,0.0);
  float Rd=H*(0.004+0.065*e);                        /* the star's disc */
  vec3 c=vec3(0.0);
  /* the photosphere: limb-darkened, granulated, white-gold at the centre, deeper gold at the limb */
  if(r<Rd){
    float x=r/Rd, mu=sqrt(1.0-x*x);
    /* granules: bright cells parted by darker lanes, the cells foreshortened towards the limb */
    vec2 q=p/(Rd*0.075); q+=(p/max(r,1e-3))*dot(p/max(r,1e-3),q)*(1.0/max(mu,0.25)-1.0)*0.5;
    float g1=1.0-abs(vnoise(vec3(q,uTime*0.5))*2.0-1.0), g2=1.0-abs(vnoise(vec3(q*2.7+7.0,uTime*0.9))*2.0-1.0);
    float gran=smoothstep(0.25,0.95,g1*0.7+g2*0.3);
    float I=(1.0-0.66*(1.0-mu)-0.1*(1.0-mu*mu))*(0.84+0.28*gran);
    /* bright, but held within the film's range, so its surface reads: the cells, the darkening to the limb */
    c+=mix(vec3(1.0,0.46,0.14),vec3(1.0,0.89,0.7),pow(mu,0.6))*I*mix(16.0,4.2,smoothstep(0.0,0.35,e))*lum;
  }
  /* the chromosphere: a thin red rim */
  c+=vec3(1.0,0.4,0.18)*exp(-pow((r-Rd)/(Rd*0.025+0.5),2.0))*mix(3.0,1.2,smoothstep(0.0,0.4,e))*lum;
  /* the corona: streamers in two scales, drifting outwards and turning slowly, white-gold to amber to a faint violet */
  float lr=log(max(r,Rd)/Rd);
  float n1=vnoise(vec3(cos(a)*5.0,sin(a)*5.0,lr*1.4-uTime*0.12)), n2=vnoise(vec3(cos(a)*17.0,sin(a)*17.0,lr*2.6-uTime*0.2+3.0));
  float stream=0.35+1.1*n1*n1+0.55*n2*n2*n2;
  vec3 ccol=mix(mix(vec3(1.0,0.93,0.8),vec3(1.0,0.66,0.32),smoothstep(0.0,1.6,lr)),vec3(0.62,0.42,0.9),smoothstep(1.8,3.6,lr));
  c+=ccol*stream*pow(Rd/max(r,Rd),1.7)*2.6*lum*smoothstep(Rd*0.98,Rd*1.05,r);
  /* the ciliary glare: hair-fine rays of every length about the core, two sets, fringed with colour at their tips */
  for(int k=0;k<2;k++){
    float N=k==0?211.0:137.0, sa=a/TAU*N+float(k)*0.37, id=floor(sa);
    float h1=hash12(vec2(id,float(k)*7.0)), h2=hash12(vec2(id+3.0,float(k)*13.0));
    float perp=abs(fract(sa)-0.5)*(TAU/N)*r;
    float L=H*(0.03+0.32*h1*h1*h1)*(0.35+0.85*e);
    float t=r/L;
    vec3 tip=mix(vec3(0.85,0.92,1.0),vec3(1.0,0.75,0.55),smoothstep(0.3,1.2,t));
    c+=tip*exp(-perp*perp/0.45)*exp(-t*2.2)*smoothstep(Rd*0.6,Rd*1.4,r)*(0.25+h2*1.4)*1.6*lum;
  }
  /* the diffraction spikes: six, banded, dispersed (each colour reaching its own length, the red the furthest) */
  for(int k=0;k<3;k++){
    float an=0.52+float(k)*PI/3.0;
    vec2 ax=vec2(cos(an),sin(an));
    float al=abs(dot(p,ax)), pe=abs(dot(p,vec2(-ax.y,ax.x)));
    float len=H*(0.05+0.24*e), w=0.7+al*0.003;
    vec3 L3=len*vec3(1.0,0.86,0.72);
    vec3 spike=exp(-pow(vec3(al)/L3,vec3(1.6)))*exp(-pe*pe/(w*w));
    float band=0.7+0.3*pow(sin(al/(H*0.012)),2.0);
    c+=spike*band*(1.0-exp(-al/(Rd*2.0+4.0)))*2.4*lum;
  }
  /* and two faint secondary spikes, the support's, square to the rest */
  { vec2 ax=vec2(cos(0.52+PI*0.5/3.0),sin(0.52+PI*0.5/3.0)); float al=abs(dot(p,ax)), pe=abs(dot(p,vec2(-ax.y,ax.x)));
    c+=vec3(0.9,0.92,1.0)*exp(-pow(al/(H*(0.03+0.12*e)),1.6))*exp(-pe*pe/0.5)*0.5*lum; }
  /* the anamorphic streak: a thin hot core and a wide cool veil */
  c+=vec3(0.5,0.68,1.0)*exp(-abs(p.y)/1.2)*exp(-abs(p.x)/(Wd*(0.05+0.42*e)))*1.3*lum;
  c+=vec3(0.32,0.45,1.0)*exp(-abs(p.y)/(H*0.012))*exp(-abs(p.x)/(Wd*(0.08+0.3*e)))*0.22*lum;
  /* a lens halo: a faint ring, each colour at its own radius */
  float rh=H*(0.11+0.12*e);
  c+=vec3(exp(-pow((r-rh*0.965)/(H*0.005),2.0)),exp(-pow((r-rh)/(H*0.005),2.0)),exp(-pow((r-rh*1.035)/(H*0.005),2.0)))*0.14*lum;
  /* the sky takes the light: a wide warm scatter */
  c+=vec3(1.0,0.8,0.52)*exp(-r/(H*0.45))*0.16*lum+vec3(1.0,0.82,0.6)*exp(-max(r-Rd,0.0)/(H*0.05))*0.7*lum*smoothstep(Rd*0.9,Rd*1.1,r);
  return c;
}

/* the shockwave of the arrival: a ring running outwards that bends the starlight it crosses */
vec2 shockBend(vec2 css,out float ring){
  ring=0.0; if(uBloom<=0.0||uBloom>=1.0) return css;
  vec2 p=css-uBloomPt; float r=length(p), H=uRes.y/uPx;
  float rs=uBloom*H*1.25, w=H*0.03, fade=1.0-uBloom;
  float g=exp(-pow((r-rs)/w,2.0));
  ring=g*fade;
  return css-(r>0.0?p/r:vec2(0.0))*g*w*0.8*fade*sign(r-rs+0.0001);
}

void main(){
  vec2 css=vec2(gl_FragCoord.x,uRes.y-gl_FragCoord.y)/uPx;
  float ring; vec2 bent=shockBend(css,ring);
  vec3 c=sky(bent);
  /* the way ahead: a faint light on the vanishing point, more of it the faster */
  float rv=length(css-uVP), dg=length(uRes/uPx);
  float sp=abs(uSpeed);
  c+=vec3(0.2,0.19,0.17)*sp*0.08*exp(-rv/(dg*0.45));
  float dust; vec3 neb=nebula(css,dust);
  c=c*(1.0-dust)+streaks(css)*mix(0.45,1.0,uDens)*(1.0-dust*0.6)+neb;
  /* the doppler: cool ahead, warm at the edges, only at the fastest */
  float dp=pow(max(sp-0.55,0.0)/0.45,2.0);
  c*=mix(vec3(1.0),mix(vec3(0.95,0.98,1.08),vec3(1.12,0.97,0.88),smoothstep(0.2,0.9,rv/dg)),dp*0.5);
  o=vec4(c,1.0);
}`;

/* what lies over the rush: the Earth, the moon, the star, the shock's light. A program of
   its own, drawn over the first and blended by how much of it still shows through (alpha), so the sum is exactly the
   one program it was: two halves compile in well under the time the whole did (Firefox, measured: 0.8 s and 1.05 s,
   against 2.9 s), the page's freeze the shorter by a second */
const OVER = SCENE.slice(0, SCENE.indexOf("void main(){")) + `void main(){
  vec2 css=vec2(gl_FragCoord.x,uRes.y-gl_FragCoord.y)/uPx;
  float ring; shockBend(css,ring);
  /* each layer over: what was beneath times (1-a), plus its own light. Kept as how much shows through (T) and what
     is added (S), so the blend gives beneath*T+S */
  float T=1.0; vec3 S=vec3(0.0);
  if(uEarthA>0.0){
    float cov; vec3 e=earth(css,cov); float a=cov*uEarthA;
    T*=1.0-a; S=S*(1.0-a)+e*uEarthA;
  }
  vec4 mo=moon(css); T*=1.0-mo.a; S=S*(1.0-mo.a)+mo.rgb;
  S+=arrival(css);
  /* the shock's own light: a bright edge, red outside and blue in */
  if(ring>0.001){
    vec2 p=css-uBloomPt; float r=length(p), H=uRes.y/uPx, rs=uBloom*H*1.25, w=H*0.006;
    vec3 band=vec3(exp(-pow((r-rs-w*0.5)/w,2.0)),exp(-pow((r-rs)/w,2.0)),exp(-pow((r-rs+w*0.5)/w,2.0)));
    S+=mix(vec3(dot(band,vec3(0.34))),band,0.35)*vec3(1.0,0.86,0.66)*0.32*(1.0-uBloom)*(1.0-uBloom);
  }
  o=vec4(S,1.0-T);
}`;

const DOWN = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec2 uTexel, uOut; uniform float uFirst; out vec4 o;
vec3 s(vec2 uv){ vec3 c=texture(uSrc,uv).rgb; if(uFirst>0.5){ float l=max(c.r,max(c.g,c.b)); c*=max(l-0.9,0.0)/max(l,1e-4); } return c; }
void main(){ vec2 uv=gl_FragCoord.xy/uOut, t=uTexel;
  vec3 a=s(uv+t*vec2(-2,2)),b=s(uv+t*vec2(0,2)),c=s(uv+t*vec2(2,2)),d=s(uv+t*vec2(-2,0)),e=s(uv),f=s(uv+t*vec2(2,0)),g=s(uv+t*vec2(-2,-2)),h=s(uv+t*vec2(0,-2)),i=s(uv+t*vec2(2,-2)),j=s(uv+t*vec2(-1,1)),k=s(uv+t*vec2(1,1)),l=s(uv+t*vec2(-1,-1)),m=s(uv+t*vec2(1,-1));
  o=vec4(e*0.125+(a+c+g+i)*0.03125+(b+d+f+h)*0.0625+(j+k+l+m)*0.125,1.0); }`;
const UPS = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec2 uTexel, uOut; out vec4 o;
void main(){ vec2 uv=gl_FragCoord.xy/uOut, t=uTexel;
  vec3 r=texture(uSrc,uv).rgb*4.0;
  r+=(texture(uSrc,uv+vec2(-t.x,0)).rgb+texture(uSrc,uv+vec2(t.x,0)).rgb+texture(uSrc,uv+vec2(0,-t.y)).rgb+texture(uSrc,uv+vec2(0,t.y)).rgb)*2.0;
  r+=texture(uSrc,uv-t).rgb+texture(uSrc,uv+t).rgb+texture(uSrc,uv+vec2(t.x,-t.y)).rgb+texture(uSrc,uv+vec2(-t.x,t.y)).rgb;
  o=vec4(r/16.0,1.0); }`;
/* the film: bloom laid in, the door's own tone curve (so the Earth here is the Earth there), grain */
const FILM = `#version 300 es
precision highp float;
uniform sampler2D uHdr, uBloom; uniform vec2 uRes; uniform float uTime, uExpo; out vec4 o;
float hash13(vec3 p){p=fract(p*0.1031);p+=dot(p,p.zyx+31.32);return fract((p.x+p.y)*p.z);}
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  vec2 r=uv-0.5; float f=0.004*dot(r,r);
  vec3 c=vec3(texture(uHdr,uv+r*f).r,texture(uHdr,uv).g,texture(uHdr,uv-r*f).b);
  c+=texture(uBloom,uv).rgb*0.22;
  c=1.0-exp(-max(c,0.0)*uExpo);
  float l=dot(c,vec3(0.2126,0.7152,0.0722)); c=max(mix(vec3(l),c,1.08),0.0);
  c=pow(c,vec3(1.0/2.2));
  float gr=hash13(vec3(gl_FragCoord.xy,floor(uTime*24.0)))+hash13(vec3(gl_FragCoord.yx*1.7,floor(uTime*24.0)+3.0))-1.0;
  c+=gr*0.03*(0.2+3.0*l*(1.0-l))+(hash13(vec3(gl_FragCoord.xy,uTime*60.0))-0.5)/255.0;
  o=vec4(c,1.0);
}`;


/* THE GALAXY, DRAWN (orbit-site world.js: SKY): used only when the picture of the
   Milky Way cannot be had. The band, its dust and nebulae, painted once into the
   same equirectangular frame the picture fills (north at the top), and read by
   SCENE exactly as the picture is. */
const SKYPAINT = `#version 300 es
precision highp float;
uniform vec2 uSize;
out vec4 o;
/* the photograph is shown at 0.35 of its light in the world, the drawn galaxy at 0.5: kept in that proportion here */
const float GAIN=0.5/0.35;
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+10.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.5-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 105.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
const mat3 ROT=mat3(0.00,0.80,0.60,-0.80,0.36,-0.48,-0.60,-0.48,0.64);
float fbm(vec3 p,int oct){float s=0.0,a=0.5;for(int i=0;i<12;i++){if(i>=oct)break;s+=a*snoise(p);p=ROT*p*2.02;a*=0.5;}return s;}
float ridged(vec3 p,int oct){float s=0.0,a=0.5,w=1.0;for(int i=0;i<12;i++){if(i>=oct)break;float n=1.0-abs(snoise(p));n*=n;n*=w;w=clamp(n*1.8,0.0,1.0);s+=a*n;p=ROT*p*2.03;a*=0.5;}return s;}
float hash13(vec3 p){p=fract(p*0.1031);p+=dot(p,p.zyx+31.32);return fract((p.x+p.y)*p.z);}
vec3 srgb(int r,int g,int b){return pow(vec3(r,g,b)/255.0,vec3(2.2));}
const float PI=3.14159265, TAU=6.28318531;
vec3 dirOf(vec2 uv){float lon=(uv.x-0.5)*TAU, lat=(uv.y-0.5)*PI; return vec3(cos(lat)*sin(lon),sin(lat),cos(lat)*cos(lon));}
void main(){
  vec2 uv=gl_FragCoord.xy/uSize;
  vec3 d=dirOf(vec2(uv.x,1.0-uv.y));
  vec3 gN=vec3(0.0,1.0,0.0), gC=vec3(0.0,0.0,1.0);
  vec3 w=vec3(fbm(d*2.5,5),fbm(d*2.5+5.0,5),fbm(d*2.5+9.0,5));
  float b=dot(d,gN)+0.05*fbm(d*3.0+w,6);
  float toCore=acos(clamp(dot(normalize(d-gN*dot(d,gN)),gC),-1.0,1.0));
  float thick=0.07+0.08*exp(-toCore*toCore/0.5);
  float band=exp(-b*b/(thick*thick));
  float bulge=exp(-(b*b)/0.02-toCore*toCore/0.18);
  float cloud=0.5+0.5*fbm(d*6.0+w*1.6,10);
  float grain=0.5+0.5*fbm(d*40.0,4);
  float lanes=smoothstep(0.3,0.85,ridged(d*5.0+w*2.0,10))*exp(-b*b/(thick*thick*0.35));
  float lanes2=smoothstep(0.45,0.9,ridged(d*13.0+w*3.0,8))*band;
  float dust=(1.0-0.92*lanes)*(1.0-0.5*lanes2);
  vec3 arm=vec3(0.66,0.68,0.92), core=vec3(1.0,0.78,0.56);
  vec3 c=band*(0.2+0.8*cloud)*(0.7+0.3*grain)*mix(arm,core,bulge*0.9+0.1)*dust*0.5;
  c+=bulge*core*0.45*dust;
  float hii=pow(max(fbm(d*9.0+w*3.0,8)+0.08,0.0),3.0)*band;
  c+=hii*vec3(1.0,0.26,0.5)*1.4*dust;
  float oiii=pow(max(fbm(d*4.0+11.0+w,7)+0.05,0.0),4.0)*(0.25+band);
  c+=oiii*vec3(0.2,0.62,0.8)*0.8*dust;
  float far=0.5+0.5*fbm(d*1.8+w,5);
  c+=vec3(0.02,0.014,0.04)*far;
  o=vec4(pow(clamp(c*0.3*GAIN,0.0,1.0),vec3(1.0/2.2)),1.0);
}`;

/* the door's camera (tools/dawn.py): over the Atlantic, facing the sunrise over Europe */
const RE = 6371, ALT = 800, LAT = 46, LON = -27, HEAD = 72, SUN_UNDER = 0.15;
/** @typedef {number[]} V3 */
/** @param {V3} a @param {V3} b @returns {V3} */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** @param {V3} a @param {V3} b */
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** @param {V3} a @param {V3} b @returns {V3} */
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** @param {V3} a @param {number} k @returns {V3} */
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
/** @param {V3} a @returns {V3} */
const norm = (a) => mul(a, 1 / Math.hypot(...a));
function doorCamera() {
  const r = Math.PI / 180, la = LAT * r, lo = LON * r, hd = HEAD * r;
  const Z = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  const E = [-Math.sin(lo), Math.cos(lo), 0], N = cross(Z, E);
  const H = add(mul(N, Math.cos(hd)), mul(E, Math.sin(hd))), R = cross(H, Z);
  const D0 = (RE + ALT) / RE, F = 3000 / Math.tan(Math.asin(1 / D0));
  /* the sun: the horizon point it rises at, turned SUN_UNDER degrees under it */
  const sd = norm(add(add(mul(R, 0), mul(H, 3000)), mul(Z, -F)));
  const ax = norm(cross(sd, mul(Z, -1))), a = SUN_UNDER * r;
  const S = norm(add(add(mul(sd, Math.cos(a)), mul(cross(ax, sd), Math.sin(a))), mul(ax, dot(ax, sd) * (1 - Math.cos(a)))));
  return { B: [...R, ...H, ...mul(Z, -1)], S, D0 };
}

/** @typedef {{ cx: number, cy: number, R: number, alpha: number, c: number }} WorldCircle */
/**
 * @typedef {object} VoyageFrame
 * @property {number} t flight time, ms
 * @property {number} v signed speed
 * @property {number} K
 * @property {number[]} vp vanishing point [x, y], css px
 * @property {number} rmax
 * @property {number[]} tint linear rgb
 * @property {number} progress 0..1 of the climb
 * @property {WorldCircle | null} world
 * @property {number} bloom 0..1
 * @property {number[]} [bloomPt]
 * @property {number} [tu] ascent time
 * @property {boolean} [star]
 * @property {boolean} [moon]
 * @property {number} dt ms since the last frame (0 when pinned)
 */

/**
 * Makes the world, detached from the page until a flight attaches it under
 * its own canvas. Null where WebGL2 (with float targets) is not there.
 */
function createVoyage() {
  if (typeof document === "undefined") return null;
  /* the page's one context, if the page may use the GPU at all (fitness.js);
     never a second one made here */
  const g = gpu();
  if (!g || g.gl.isContextLost()) return null;
  if (!g.gl.getExtension("EXT_color_buffer_float")) { sayVerdict("off: no float colour buffers (EXT_color_buffer_float)"); return null; }
  const { canvas, gl, renderer } = g;
  canvas.id = "warpgl"; canvas.setAttribute("aria-hidden", "true");
  gl.getExtension("OES_texture_float_linear");
  const since = performance.now();
  /* this browser's localStorage, where it will give it */
  const storage = () => { try { return globalThis.localStorage ?? undefined; } catch { return undefined; } };

  let ok = false, dead = false, ready = false;
  /* a lost context is a world that can no longer be drawn: the flight goes on without it */
  canvas.addEventListener("webglcontextlost", () => { dead = true; ok = false; ready = false; });

  /* the shaders are made in the background where the browser can
     (KHR_parallel_shader_compile): asked for here, and only looked at once
     they are done, so making them never holds the page up */
  const par = g.parallel ? gl.getExtension("KHR_parallel_shader_compile") : null;
  /** @param {number} type @param {string} src */
  const shader = (type, src) => {
    const s = /** @type {WebGLShader} */ (gl.createShader(type)); gl.shaderSource(s, src); gl.compileShader(s); return s;
  };
  const vs = shader(gl.VERTEX_SHADER, VERT);
  /** @typedef {{ p: WebGLProgram, fs: WebGLShader, vsh: WebGLShader, u: Record<string, WebGLUniformLocation | null> }} Prog */
  /** @param {string} fsrc @returns {Prog} */
  const program = (fsrc, vsh = vs) => {
    const p = /** @type {WebGLProgram} */ (gl.createProgram()), fs = shader(gl.FRAGMENT_SHADER, fsrc);
    gl.attachShader(p, vsh); gl.attachShader(p, fs); gl.linkProgram(p);
    return { p, fs, vsh, u: {} };
  };
  /** @param {Prog} pr */
  const finish = (pr) => {
    if (!gl.getProgramParameter(pr.p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(pr.p) || gl.getShaderInfoLog(pr.fs) || gl.getShaderInfoLog(pr.vsh) || "link failed");
    }
    const n = gl.getProgramParameter(pr.p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const a = /** @type {WebGLActiveInfo} */ (gl.getActiveUniform(pr.p, i));
      pr.u[a.name.replace(/\[0\]$/, "")] = gl.getUniformLocation(pr.p, a.name);
    }
  };
  /** @param {Prog[]} list @returns {Promise<void>} */
  const compiled = (list) => new Promise((resolve) => {
    if (!par) { resolve(); return; }
    const poll = () => (dead || list.every((pr) => gl.getProgramParameter(pr.p, par.COMPLETION_STATUS_KHR))
      ? resolve() : setTimeout(poll, 40));
    poll();
  });
  const P = { scene: program(SCENE), over: program(OVER), down: program(DOWN), up: program(UPS), film: program(FILM) };
  const core = Object.values(P);
  const made = compiled(core).then(() => {
    if (dead) return false;
    try { core.forEach(finish); ok = true; note("flight: compiled", since); } catch (e) { console.warn("orbit: the flight's world could not be made", e); dead = true; }
    return ok;
  });
  const vao = gl.createVertexArray();

  /** @param {number} w @param {number} h @param {number} fmt @param {number} f @param {number} type @param {ArrayBufferView | null} [data] */
  const tex = (w, h, fmt, f, type, data = null) => {
    const t = /** @type {WebGLTexture} */ (gl.createTexture()); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, f, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  /** @typedef {{ t: WebGLTexture, f: WebGLFramebuffer, w: number, h: number }} Target */
  /** @param {WebGLTexture} t @returns {WebGLFramebuffer} */
  const fbOf = (t) => {
    const f = /** @type {WebGLFramebuffer} */ (gl.createFramebuffer());
    gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return f;
  };
  /** @param {number} w @param {number} h @returns {Target} */
  const target = (w, h) => { const t = tex(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT); return { t, f: fbOf(t), w, h }; };

  /* the maps: each fetched and decoded as soon as it is asked for (off the
     page's thread), and put on the GPU as a chore of its own: never all at once */
  /** @type {Record<string, WebGLTexture>} */
  const maps = {};
  /** @param {() => void} fn */
  const inTurn = (fn) => chore(fn, 60, "flight");
  /** @param {keyof typeof TEX} key @returns {Promise<boolean>} */
  const load = (key) => (TEX[key] ? fetchOnce(/** @type {string} */ (TEX[key])) : Promise.reject(new Error("no picture")))
    .then((b) => createImageBitmap(b, { colorSpaceConversion: "none", premultiplyAlpha: "none" }))
    .then((bm) => inTurn(() => {
      if (dead) return;
      const t = /** @type {WebGLTexture} */ (gl.createTexture()); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bm);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, key === "euro" ? gl.CLAMP_TO_EDGE : gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      bm.close?.();
      maps[key] = t;
    })).then(() => true, () => false);

  /* without the Milky Way's picture: the galaxy drawn (SKYPAINT), a strip at a
     time, each strip a chore, into the frame the picture would have filled */
  const KW = 1024, KH = 512, STRIPS = 4;
  async function paintSky() {
    const pr = await chore(() => program(SKYPAINT), 60, "flight");
    await compiled([pr]);
    if (dead) return;
    await chore(() => finish(pr), 60, "flight");
    const t = tex(KW, KH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE), f = fbOf(t);
    for (let i = 0; i < STRIPS; i++) {
      await chore(() => {
        if (dead) return;
        gl.disable(gl.BLEND); gl.enable(gl.SCISSOR_TEST); gl.scissor(0, (KH / STRIPS) * i, KW, KH / STRIPS);
        pass(pr, f, KW, KH, (u) => gl.uniform2f(u.uSize, KW, KH));
        gl.disable(gl.SCISSOR_TEST); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }, 60, "flight");
    }
    await chore(() => {
      if (dead) return;
      gl.bindTexture(gl.TEXTURE_2D, t); gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      maps.sky = t;
    }, 60, "flight");
  }

  /* the maps, the warm-up and the measure, asked for once; resolves when the
     world can be drawn as it should be (or never will be) */
  /** @type {Promise<unknown> | null} */
  let loading = null;
  /** @type {Promise<void> | null} */
  let warming = null;
  /**
   * `prove: false` (the door, #1253) makes the programs and puts the maps on
   * the GPU and stops there: the drawn warm-up and the fitness test below
   * (a resize and a read back each) wait for a call that proves, which is
   * the flight's own when it starts.
   * @param {{ prove?: boolean }} [how]
   */
  function warm({ prove = true } = {}) {
    if (!loading) {
      const sky = load("sky").then((had) => (had ? undefined : paintSky().catch((e) => console.warn("orbit: the galaxy could not be drawn", e))));
      loading = Promise.all([made, sky, ...(/** @type {(keyof typeof TEX)[]} */ (["lights", "euro", "clouds", "day", "moon"])).map(load)]);
    }
    if (!prove) return loading.then(() => {});
    if (!warming) {
      /** @returns {VoyageFrame} */
      const ST = () => ({ t: 1900, v: 1, K: 7.4, vp: [W / 2, -0.55 * H], rmax: Math.hypot(W, H) * 1.55, tint: [1, 0.8, 0.4],
        progress: 0.4, world: null, bloom: 0, tu: 1900, star: true, dt: 0 });
      warming = loading
        /* each way the flight draws, drawn once into a corner of a few pixels,
           so the GPU has everything made for it (drivers finish their shaders
           on the first draw) before a flight, at no cost to see */
        .then(() => chore(() => touch(ST()), 60, "flight"))
        .then(() => chore(() => touch({ ...ST(), world: { cx: W / 2, cy: H * 3, R: H * 2.4, alpha: 1, c: 0.1 }, tu: 900 }), 60, "flight"))
        /* and whether this machine can draw it at all (#1253): a GPU that
           cannot (software rendering, a remote desktop) would make every
           frame a long stall, and the journey's clock would stretch the climb
           to many times its length. Such a world is never ready, and the
           flight draws on its own canvas, as it always could. Asked once per
           GPU and build (#1310, fitness.js rememberedFit): a verdict already
           measured here is taken as it was, and the test's frames are skipped */
        .then(() => {
          const known = ok ? rememberedFit(storage(), renderer, version) : null;
          if (known) {
            fit = known.fit;
            sayVerdict(`${known.fit ? "on" : "off"}: frame ${Math.round(known.ms)} ms, remembered for this GPU and build`);
            return;
          }
          return chore(() => {
            const measured = fitness();
            fit = measured.fit;
            if (ok && !dead) rememberFit(storage(), renderer, version, measured);
          }, 60, "flight");
        })
        .then(() => { ready = ok && !dead && fit; note(`flight: ${ready ? "ready" : fit ? "not made" : "too slow here, drawn without it"}`, since); });
      /* the measure is never hurried, and nothing waits on it */
      warming.then(() => chore(calibrate, 200, "measure"));
    }
    return warming;
  }
  /** @param {VoyageFrame} st */
  function touch(st) {
    if (!ok) return;
    if (W < 2) resize(innerWidth, innerHeight);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, 4, 4);
    try { draw(st); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); } catch { /* fine */ }
    gl.disable(gl.SCISSOR_TEST); lastDraw = 0;
  }
  /* the fitness test: whole frames at the heaviest point of the flight, at
     the smallest drawing the measure would ever choose, warmed first and
     judged on their median (fitness.js frameCost); fit if that leaves room
     for about 30 frames a second. Says its verdict in the console. */
  let fit = false;
  /** @returns {{ fit: boolean, ms: number }} */
  function fitness() {
    if (!ok) return { fit: false, ms: Infinity };
    if (W < 2) resize(innerWidth, innerHeight);
    const was = part;
    part = 0.4; CW = 0; resize(W, H);
    /** @type {VoyageFrame} */
    const st = { t: 1900, v: 1, K: 7.4, vp: [W / 2, -0.55 * H], rmax: Math.hypot(W, H) * 1.55, tint: [1, 0.8, 0.4],
      progress: 0.4, world: null, bloom: 0, tu: 1900, star: true, dt: 0 };
    const { fit: fits, ms } = frameCost(gl, () => draw(st));
    part = was; CW = 0; resize(W, H); lastDraw = 0;
    sayVerdict(fits ? `on (frame ${Math.round(ms)} ms)` : `off: frame ${Number.isFinite(ms) ? Math.round(ms) : "failed to draw"}${Number.isFinite(ms) ? " ms" : ""}`);
    return { fit: fits, ms };
  }
  /* the measure: a few whole frames at the heaviest point of the flight (the
     nebula, the streaks at full speed), timed, and the drawing's size chosen
     so a frame takes about 11 ms here */
  function calibrate() {
    if (!ok || !fit || document.hidden || (lastDraw && performance.now() - lastDraw < 5000)) return;
    if (W < 2) resize(innerWidth, innerHeight);
    /** @type {VoyageFrame} */
    const st = { t: 1900, v: 1, K: 7.4, vp: [W / 2, -0.55 * H], rmax: Math.hypot(W, H) * 1.55, tint: [1, 0.8, 0.4],
      progress: 0.4, world: null, bloom: 0, tu: 1900, star: true, dt: 0 };
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    try {
      draw(st); sync();
      const t0 = performance.now(); for (let i = 0; i < 2; i++) draw(st); sync();
      const ms = (performance.now() - t0) / 2;
      const next = Math.min(0.9, Math.max(0.4, part * Math.sqrt(11 / Math.max(ms, 1))));
      if (Math.abs(next - part) > 0.02) { part = next; CW = 0; resize(W, H); }
    } catch { /* drawn as it is */ }
    lastDraw = 0;
  }
  const blank = tex(1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));

  const cam = doorCamera();
  let W = 1, H = 1, part = 0.75, CW = 0, CH = 0, lastDraw = 0;
  /** @type {Target | null} */
  let hdr = null;
  /** @type {Target[]} */
  let chain = [];
  /** @type {number[]} */
  let frames = [];
  /* the streaks' travel, per depth: log radius, integrated from the flight's own speed */
  const off = [0, 0.3, 0.7, 0.15];

  /** @param {number} w @param {number} h */
  function resize(w, h) {
    W = w; H = h;
    if (dead) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    /* the whole frame is moving: drawn at a part of the screen's density, no more than about 1.6 million pixels */
    const px = Math.min(dpr * part, Math.sqrt(1.6e6 / Math.max(1, W * H)));
    const cw = Math.max(1, Math.round(W * px)), ch = Math.max(1, Math.round(H * px));
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    if (cw === CW && ch === CH) return;
    CW = cw; CH = ch; canvas.width = cw; canvas.height = ch;
    for (const c of [hdr, ...chain]) if (c) { gl.deleteTexture(c.t); gl.deleteFramebuffer(c.f); }
    hdr = target(cw, ch); chain = [];
    /* the bloom's halvings are a fixed share of the screen's height, not of
       the drawing, so its glow spreads the same however finely the frame is
       drawn and whatever the window */
    let b = 900, a = Math.max(1, Math.round(b * W / Math.max(1, H)));
    for (let i = 0; i < 5; i++) { a = Math.max(1, a >> 1); b = Math.max(1, b >> 1); chain.push(target(a, b)); }
  }
  /** @param {Prog} prog @param {WebGLFramebuffer | null} fbo @param {number} w @param {number} h @param {(u: Prog["u"]) => void} setup */
  const pass = (prog, fbo, w, h, setup) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, w, h);
    gl.useProgram(prog.p); gl.bindVertexArray(vao); setup(prog.u); gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  /** @param {number} unit @param {WebGLTexture} t @param {WebGLUniformLocation | null} loc */
  const bind = (unit, t, loc) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(loc, unit); };

  /* the flight's speed moves the streaks: each depth outwards at its own rate */
  let nebOff = 0;
  /** @param {number} v @param {number} dt @param {number} K */
  function advance(v, dt, K) { for (let i = 0; i < 4; i++) off[i] += v * dt * K * (0.35 + 0.22 * i) * 0.55; nebOff += v * dt * K * 0.16; }

  /** @param {VoyageFrame} s */
  function draw(s) {
    if (!ok) return;
    if (!hdr) resize(W, H);
    const H0 = /** @type {Target} */ (hdr);
    /* the size is never changed mid-flight (a change reallocates every
       target, and that is a hitch): a slow flight is noted, and the next one
       is drawn smaller, the change made while nothing is flying */
    lastDraw = performance.now();
    if (s.dt) {
      frames.push(s.dt);
      if (frames.length === 40) {
        const avg = frames.slice(5).reduce((a, b) => a + b, 0) / 35;
        const next = avg > 26 ? Math.max(0.4, part * 0.82) : avg < 13 ? Math.min(0.9, part * 1.08) : part;
        if (Math.abs(next - part) > 0.02) setTimeout(function later() {
          if (performance.now() - lastDraw < 400) { setTimeout(later, 1000); return; }
          part = next; resize(W, H);
        }, 1000);
      }
    }
    const px = CW / W;
    const sp = Math.abs(s.v), shutter = 0.016 * (1 + 0.9 * sp * sp);
    const len = [0, 1, 2, 3].map((i) => Math.abs(s.v) * s.K * (0.35 + 0.22 * i) * shutter * 0.55 * 2.0);
    const w = s.world;
    /* the camera's height over the Earth grows as the world shrinks on the screen */
    const D = w ? cam.D0 * Math.pow(1 + 6 * Math.pow(w.c, 1.3), 0.6) : cam.D0;
    /* the sky turns as the climb tilts towards the way ahead */
    const pitch = -0.32 + 0.55 * s.progress, yaw = 2.5 + 0.12 * s.progress, roll = 0.62;
    const cx = Math.cos(pitch), sx = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw), cz = Math.cos(roll), sz = Math.sin(roll);
    /* Ry · Rx · Rz, column-major */
    const Rz = [cz, sz, 0, -sz, cz, 0, 0, 0, 1], Rx = [1, 0, 0, 0, cx, sx, 0, -sx, cx], Ry = [cy, 0, -sy, 0, 1, 0, sy, 0, cy];
    /** @param {number[]} a @param {number[]} b */
    const mm = (a, b) => { const o = []; for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o.push(a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2]); return o; };
    const SK = mm(Ry, mm(Rx, Rz));
    gl.disable(gl.BLEND);
    /** @param {Prog["u"]} u */
    const sceneU = (u) => {
      gl.uniform2f(u.uRes, CW, CH); gl.uniform1f(u.uPx, px); gl.uniform1f(u.uTime, (s.t / 1000) % 1000);
      gl.uniform2f(u.uVP, s.vp[0], s.vp[1]); gl.uniform1f(u.uSpeed, s.v); gl.uniform1f(u.uRmax, s.rmax);
      gl.uniform4fv(u.uOff, off); gl.uniform4fv(u.uLen, len); gl.uniform3fv(u.uTint, s.tint);
      gl.uniform3f(u.uCirc, w ? w.cx : 0, w ? w.cy : 0, w ? w.R : 1); gl.uniform1f(u.uEarthA, w ? w.alpha : 0); gl.uniform1f(u.uD, D);
      gl.uniformMatrix3fv(u.uB, false, new Float32Array(cam.B)); gl.uniform3fv(u.uSun, cam.S);
      gl.uniform4f(u.uHas, maps.lights ? 1 : 0, maps.euro ? 1 : 0, maps.clouds && maps.day ? 1 : 0, maps.sky ? 1 : 0);
      gl.uniform4f(u.uEuroBox, EURO[0], EURO[1], EURO[2], EURO[3]);
      gl.uniformMatrix3fv(u.uSkyM, false, new Float32Array(SK)); gl.uniform1f(u.uStarA, 1);
      /* how thick the field is: the door's sparse sky at rest, filling in as the flight gathers speed */
      { const q = Math.min(1, Math.max(0, (Math.abs(s.v) - 0.03) / 0.6)); gl.uniform1f(u.uDens, q * q * (3 - 2 * q)); }
      /** @param {number} a @param {number} b @param {number} x */
      const sm = (a, b, x) => { const q = Math.min(1, Math.max(0, (x - a) / (b - a))); return q * q * (3 - 2 * q); };
      const tu = s.tu ?? s.t;
      /* the nebula, through the cruise */
      gl.uniform1f(u.uNeb, sm(1200, 1750, tu) * (1 - sm(2350, 2950, tu))); gl.uniform1f(u.uNebOff, nebOff);
      /* the moon, through the acceleration: from near the way ahead, out past the lower right, growing */
      /** @param {number} m */
      const mAt = (m) => {
        const tx = W * 0.8, ty = H * 0.68, dx = tx - s.vp[0], dy = ty - s.vp[1], dl = Math.hypot(dx, dy) || 1;
        const r0 = Math.min(dl * 0.35, H * 0.3), r1 = dl + H * 0.75, e = Math.pow(m, 2.3);
        return [s.vp[0] + (dx / dl) * (r0 + (r1 - r0) * e), s.vp[1] + (dy / dl) * (r0 + (r1 - r0) * e), H * (0.003 + 0.6 * Math.pow(m, 3.2))];
      };
      const mt = (tu - 700) / 800;
      if (maps.moon && mt > 0 && mt < 1 && s.moon !== false) {
        const a = mAt(mt), b = mAt(Math.max(0, mt - (1 / 60) / 0.8));
        /* it comes out of the distance: tiny, and faint until it is a third of the way */
        gl.uniform4f(u.uMoonS, a[0], a[1], a[2], sm(0, 0.35, mt)); gl.uniform2f(u.uMoonV, (a[0] - b[0]) * 0.5, (a[1] - b[1]) * 0.5);
      } else gl.uniform4f(u.uMoonS, 0, 0, 1, 0);
      gl.uniform1f(u.uMoonSpin, 0.6 + tu * 0.00025);
      bind(5, maps.moon || blank, u.uMoonT);
      gl.uniform1f(u.uPre, s.bloom != null && s.star !== false ? sm(2500, 3300, tu) : 0);
      gl.uniform1f(u.uBloom, s.bloom || 0); gl.uniform2f(u.uBloomPt, s.bloomPt?.[0] ?? W / 2, s.bloomPt?.[1] ?? H / 2);
      bind(0, maps.lights || blank, u.uLights); bind(1, maps.day || blank, u.uDay); bind(2, maps.clouds || blank, u.uClouds);
      bind(3, maps.euro || blank, u.uEuro); bind(4, maps.sky || blank, u.uSky);
    };
    pass(P.scene, H0.f, CW, CH, sceneU);
    /* and what lies over it (OVER, above), blended by how much of the first still shows through */
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    pass(P.over, H0.f, CW, CH, sceneU);
    gl.disable(gl.BLEND);
    let src = H0;
    chain.forEach((c, i) => {
      pass(P.down, c.f, c.w, c.h, (u) => { bind(0, src.t, u.uSrc); gl.uniform2f(u.uTexel, 1 / src.w, 1 / src.h); gl.uniform2f(u.uOut, c.w, c.h); gl.uniform1f(u.uFirst, i === 0 ? 1 : 0); });
      src = c;
    });
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = chain.length - 1; i > 0; i--) {
      const from = chain[i], to = chain[i - 1];
      pass(P.up, to.f, to.w, to.h, (u) => { bind(0, from.t, u.uSrc); gl.uniform2f(u.uTexel, 1 / from.w, 1 / from.h); gl.uniform2f(u.uOut, to.w, to.h); });
    }
    gl.disable(gl.BLEND);
    pass(P.film, null, CW, CH, (u) => {
      bind(0, H0.t, u.uHdr); bind(1, chain[0].t, u.uBloom); gl.uniform2f(u.uRes, CW, CH);
      gl.uniform1f(u.uTime, (s.t / 1000) % 1000); gl.uniform1f(u.uExpo, 0.35);
    });
  }
  function clear() {
    if (!ok) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clearColor(0.012, 0.012, 0.014, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  }
  /** set the world beneath a flight's own canvas @param {HTMLCanvasElement} under */
  function attach(under) {
    if (!under.parentNode || canvas.nextSibling === under) return;
    under.parentNode.insertBefore(canvas, under);
  }
  return {
    canvas, resize, draw, advance, clear, warm, made, attach,
    /** compiled, its maps on the GPU and drawn once: a flight may use it */
    get ready() { return ready && ok && !dead; },
    get dead() { return dead; },
    reset() { off.splice(0, 4, 0, 0.3, 0.7, 0.15); nebOff = 0; frames = []; },
  };
}

/** @typedef {NonNullable<ReturnType<typeof createVoyage>>} Voyage */
/** @type {Voyage | null | undefined} */
let only;
/**
 * The page's one world (every flight on a page shares it, so the work of
 * readying it is done once). Null where it cannot be had.
 * @returns {Voyage | null}
 */
export function voyageOnce() {
  if (only === undefined) {
    try { only = createVoyage(); } catch (e) { console.warn("orbit: the flight's world could not be made", e); only = null; }
  }
  if (only?.dead) only = null;
  return only;
}
/** The page's world if something has already made it; never makes it. */
export function voyageIfMade() {
  if (only?.dead) only = null;
  return only ?? null;
}

/**
 * Whether this browser makes shaders in the background
 * (KHR_parallel_shader_compile). Where it does not, making them stops the page
 * for as long as it takes, so the door never asks for it. Asked of the page's
 * one context (fitness.js); false where the page may not use the GPU.
 */
export function compilesAside() {
  /* asked of the page's one context (fitness.js), never of a throwaway */
  return gpu()?.parallel ?? false;
}

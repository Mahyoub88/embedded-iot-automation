// Executable behavioral specification. Not PIC firmware or physical test evidence.
export const DEFAULTS = Object.freeze({fanOff:28,fanOn:32,tempAlarm:40,rhAlarm:70,unlockMs:5000,doorMs:30000,lockoutMs:30000,pin:'2468',schedule:false,startMinute:480,endMinute:1080});
export function validSettings(s) {
  return [s.fanOff,s.fanOn,s.tempAlarm,s.rhAlarm,s.unlockMs,s.doorMs,s.lockoutMs,s.startMinute,s.endMinute].every(Number.isInteger)
    && s.fanOff>=0 && s.fanOff<s.fanOn && s.fanOn<s.tempAlarm && s.tempAlarm<=100
    && s.rhAlarm>0 && s.rhAlarm<=100 && s.unlockMs>=1000 && s.unlockMs<=30000
    && s.doorMs>=1000 && s.doorMs<=600000 && s.lockoutMs>=1000 && s.lockoutMs<=600000
    && /^\d{4}$/.test(s.pin) && typeof s.schedule==='boolean'
    && s.startMinute>=0 && s.startMinute<1440 && s.endMinute>=0 && s.endMinute<1440;
}
export function crc16(bytes) {
  let crc=0xffff;
  for(const byte of bytes){crc^=byte<<8;for(let i=0;i<8;i++)crc=((crc<<1)^((crc&0x8000)?0x1021:0))&0xffff;}
  return crc;
}
const put16=(b,i,v)=>{b[i]=v&255;b[i+1]=(v>>>8)&255;};
const get16=(b,i)=>b[i]|(b[i+1]<<8);
function encode(settings,sequence){
  const b=new Uint8Array(32);b.fill(255);b[0]=0x52;b[1]=1;put16(b,2,sequence);
  ['fanOff','fanOn','tempAlarm','rhAlarm'].forEach((k,i)=>b[4+i]=settings[k]);
  put16(b,8,settings.unlockMs/1000);put16(b,10,settings.doorMs/1000);put16(b,12,settings.lockoutMs/1000);
  b[14]=Number(settings.schedule);put16(b,15,settings.startMinute);put16(b,17,settings.endMinute);
  [...settings.pin].forEach((d,i)=>b[19+i]=Number(d));b[23]=0;
  put16(b,24,crc16(b.slice(0,24)));b[31]=0xa5;return b;
}
function decode(b){
  if(b[31]!==0xa5||b[0]!==0x52||b[1]!==1||get16(b,24)!==crc16(b.slice(0,24))||b[14]>1||b.slice(19,23).some(x=>x>9))return null;
  const s={fanOff:b[4],fanOn:b[5],tempAlarm:b[6],rhAlarm:b[7],unlockMs:get16(b,8)*1000,doorMs:get16(b,10)*1000,lockoutMs:get16(b,12)*1000,schedule:Boolean(b[14]),startMinute:get16(b,15),endMinute:get16(b,17),pin:b.slice(19,23).join('')};
  return validSettings(s)?{settings:s,sequence:get16(b,2)}:null;
}
export class SettingsStore {
  constructor(bytes){this.bytes=bytes?new Uint8Array(bytes):new Uint8Array(256).fill(255);if(this.bytes.length!==256)throw Error('Expected 256 EEPROM bytes');}
  records(){return [0,32].map(offset=>{const r=decode(this.bytes.slice(offset,offset+32));return r?{...r,offset}:null;});}
  latest(){const [a,b]=this.records();if(!a)return b;if(!b)return a;const distance=(b.sequence-a.sequence)&0xffff;return distance>0&&distance<32768?b:a;}
  load(){return this.latest()?.settings??{...DEFAULTS};}
  save(settings,interruptBeforeWrite=Infinity){
    if(!validSettings(settings)||[settings.unlockMs,settings.doorMs,settings.lockoutMs].some(x=>x%1000))throw Error('Invalid settings');
    const current=this.latest();if(current&&Object.keys(DEFAULTS).every(k=>current.settings[k]===settings[k]))return {changed:false,completed:true,writes:0};
    const offset=current?.offset===0?32:0,sequence=((current?.sequence??65535)+1)&65535,b=encode(settings,sequence);
    const writes=[[offset+31,0],...Array.from({length:31},(_,i)=>[offset+i,b[i]]),[offset+31,0xa5]];
    for(let i=0;i<writes.length;i++){if(i===interruptBeforeWrite)return {changed:true,completed:false,writes:i};const [address,value]=writes[i];this.bytes[address]=value;
      if(i===31){const preview=this.bytes.slice(offset,offset+32);preview[31]=0xa5;if(!decode(preview))throw Error('Read-back failed');}}
    return {changed:true,completed:true,writes:writes.length};
  }
}
export class RoomController {
  constructor(settings=DEFAULTS){if(!validSettings(settings))throw Error('Invalid settings');this.settings={...settings};this.now=0;this.temp=null;this.rh=null;this.tempAt=-Infinity;this.rhAt=-Infinity;this.fan=false;this.unlockUntil=0;this.authorizedUntil=0;this.lockoutUntil=0;this.failures=0;this.doorSince=null;this.acknowledged=new Set();this.active=new Set();}
  step(now,input={}){
    if(!Number.isFinite(now)||now<this.now)throw Error('Monotonic time required');this.now=now;
    if(Object.hasOwn(input,'temp')&&Number.isFinite(input.temp)&&input.temp>=0&&input.temp<=100){this.temp=input.temp;this.tempAt=now;}
    if(Object.hasOwn(input,'temp')&&!(Number.isFinite(input.temp)&&input.temp>=0&&input.temp<=100)){this.temp=null;this.tempAt=-Infinity;}
    if(Object.hasOwn(input,'rh')&&Number.isFinite(input.rh)&&input.rh>=0&&input.rh<=100){this.rh=input.rh;this.rhAt=now;}
    if(Object.hasOwn(input,'rh')&&!(Number.isFinite(input.rh)&&input.rh>=0&&input.rh<=100)){this.rh=null;this.rhAt=-Infinity;}
    const s=this.settings,tempOK=now-this.tempAt<=3000,rhOK=now-this.rhAt<=3000;
    if(!tempOK)this.fan=true;else if(this.temp>=s.fanOn)this.fan=true;else if(this.temp<=s.fanOff)this.fan=false;
    let access='idle';
    if(input.exit){this.unlockUntil=now+s.unlockMs;this.authorizedUntil=this.unlockUntil+5000;access='exit release';}
    else if(Object.hasOwn(input,'pin')){
      if(now<this.lockoutUntil)access='lockout';
      else if(input.pin!==s.pin){this.failures++;access='denied';if(this.failures>=3){this.lockoutUntil=now+s.lockoutMs;this.failures=0;access='lockout';}}
      else if(s.schedule&&(!input.rtcValid||!Number.isInteger(input.minute)||input.minute<0||input.minute>=1440||!inWindow(input.minute,s.startMinute,s.endMinute)))access='time denied';
      else{this.unlockUntil=now+s.unlockMs;this.authorizedUntil=this.unlockUntil+5000;this.failures=0;access='granted';}
    }
    const door=Boolean(input.doorOpen);if(!door)this.doorSince=null;else if(this.doorSince===null)this.doorSince=now;
    const alarms=[];if(!tempOK)alarms.push('temperature fault');else if(this.temp>=s.tempAlarm)alarms.push('high temperature');
    if(door&&now>=this.authorizedUntil)alarms.push('unauthorized door');if(door&&now-this.doorSince>=s.doorMs)alarms.push('door open too long');
    if(!rhOK)alarms.push('humidity fault');else if(this.rh>=s.rhAlarm)alarms.push('high humidity');
    if(!input.rtcValid)alarms.push('RTC fault');if(now<this.lockoutUntil)alarms.push('keypad lockout');
    this.active=new Set(alarms);this.acknowledged=new Set([...this.acknowledged].filter(a=>this.active.has(a)));
    if(input.ack)this.acknowledged=new Set(alarms);
    return {fan:this.fan,unlock:now<this.unlockUntil,access,alarms,buzzer:alarms.some(a=>!this.acknowledged.has(a)),temp:tempOK?this.temp:null,rh:rhOK?this.rh:null,lockoutRemaining:Math.max(0,this.lockoutUntil-now)};
  }
}
export function inWindow(minute,start,end){return start===end?true:start<end?minute>=start&&minute<end:minute>=start||minute<end;}

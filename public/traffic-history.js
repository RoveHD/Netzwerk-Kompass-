const list=value=>Array.isArray(value)?value:[];
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const normalizedMac=value=>typeof value==='string'&&value.trim()?value.trim().replace(/^mac:/i,'').toUpperCase():'';

export function trafficSources(records=[],fritzbox={}) {
  const sources=new Map();
  const add=(id,label,scope)=>{if(!sources.has(id))sources.set(id,{id,label,scope,points:[],reason:null,kind:id==='pc'?'pc':id==='wan'?'router':'device',known:false,active:null,available:false});return sources.get(id);};
  add('pc','Dieser PC','Adapterverkehr einschließlich lokalem Netz');
  add('wan','FRITZ!Box gesamt','Internetverkehr des gesamten Anschlusses');

  const masterKeys=nodes=>{
    const macs=new Set(),ids=new Set();
    for(const node of list(nodes))if(String(node?.role||'').toUpperCase()==='MASTER'){
      const mac=normalizedMac(node.mac);if(mac)macs.add(mac);
      if(node.id)ids.add(String(node.id));
    }
    return {macs,ids};
  };
  const currentMasters=masterKeys(fritzbox?.mesh?.nodes);
  const identities=new Map();let anonymous=0;
  const identity=row=>{
    const mac=normalizedMac(row?.mac)||normalizedMac(row?.id?.startsWith?.('mac:')?row.id:'');
    if(mac)return `mac:${mac}`;
    if(row?.nodeId)return `node:${row.nodeId}`;
    if(row?.id)return `node:${row.id}`;
    return `unknown:${++anonymous}`;
  };
  const isMaster=(row,snapshot)=>{
    if(String(row?.role||'').toUpperCase()==='MASTER')return true;
    const mac=normalizedMac(row?.mac)||normalizedMac(row?.id?.startsWith?.('mac:')?row.id:'');
    return (mac&&(currentMasters.macs.has(mac)||snapshot.masters.macs.has(mac)))||
      (row?.nodeId&&(currentMasters.ids.has(String(row.nodeId))||snapshot.masters.ids.has(String(row.nodeId))))||
      (row?.id&&(currentMasters.ids.has(String(row.id))||snapshot.masters.ids.has(String(row.id))));
  };
  const snapshot=(key,nodes)=>({key,masters:masterKeys(nodes),ipAliases:new Map()});
  const currentSnapshot=snapshot('current',fritzbox?.mesh?.nodes);
  const device=(row,context)=>{
    if(!row||isMaster(row,context))return null;
    const mac=normalizedMac(row?.mac)||normalizedMac(row?.id?.startsWith?.('mac:')?row.id:'');
    const durableKey=identity(row);const alias=row?.ip?context.ipAliases.get(row.ip):null;
    let key=durableKey;
    // IP can reconcile otherwise unidentified entries only inside the same snapshot.
    if(!mac&&!row?.nodeId&&!row?.id&&alias?.noMac)key=alias.key;
    else if(!mac&&!row?.nodeId&&!row?.id&&row?.ip)key=`snapshot:${context.key}:ip:${row.ip}`;
    let source=identities.get(key);
    if(!source){source=add(`device:${key}`,row.name||row.ip||'Unbenanntes Gerät','Internetverkehr dieses Geräts');identities.set(key,source);}
    if(row?.ip&&!context.ipAliases.has(row.ip))context.ipAliases.set(row.ip,{key,noMac:!mac});
    else if(row?.ip&&context.ipAliases.get(row.ip)?.key!==key)context.ipAliases.set(row.ip,null);
    source.known=true;
    // Each later poll/snapshot supplies the freshest device metadata, including a renamed device.
    if(row.name)source.label=row.name;
    if(row.ip)source.ip=row.ip;
    if(row.mac)source.mac=row.mac;
    if(row.active!==undefined)source.active=typeof row.active==='boolean'?row.active:null;
    if(typeof row.available==='boolean')source.available=row.available;
    else if(typeof row.rateAvailable==='boolean')source.available=row.rateAvailable;
    const hasReason=Object.hasOwn(row,'measurementReason')||Object.hasOwn(row,'reason');
    const reason=Object.hasOwn(row,'measurementReason')?row.measurementReason:row.reason;
    if(hasReason)source.reason=reason||null;
    else if(row.available===true||row.rateAvailable===true)source.reason=null;
    return source;
  };

  for(const record of records) {
    const epoch=`${record.appSessionId||'legacy'}:${record.sessionId||record.epoch||record.measurementStartedAt||'legacy'}`;
    if(record.type==='traffic')add('pc','Dieser PC').points.push({at:record.at,epoch:`${epoch}:${record.interfaceId}`,appSessionId:record.appSessionId||null,measurementStartedAt:record.measurementStartedAt||null,measurementEpoch:record.epoch??null,interfaceId:record.interfaceId||null,downloadMbps:record.downloadMbps,uploadMbps:record.uploadMbps});
    if(record.type==='fritzbox') {
      add('wan','FRITZ!Box gesamt').points.push({at:record.at,epoch,appSessionId:record.appSessionId||null,measurementStartedAt:record.measurementStartedAt||null,measurementEpoch:record.epoch??null,downloadMbps:record.wan?.downloadMbps,uploadMbps:record.wan?.uploadMbps});
      const context=snapshot(`record:${epoch}:${record.at}`,record.mesh?.nodes);
      for(const row of list(record.deviceTraffic)) {
        const source=device(row,context);if(!source)continue;
        source.points.push({at:row.at||record.at,epoch,appSessionId:record.appSessionId||null,measurementStartedAt:record.measurementStartedAt||null,measurementEpoch:record.epoch??null,downloadMbps:row.rateAvailable===false?null:row.downloadMbps,uploadMbps:row.rateAvailable===false?null:row.uploadMbps,downloadDeltaBytes:row.downloadDeltaBytes,uploadDeltaBytes:row.uploadDeltaBytes,intervalStartedAt:row.intervalStartedAt});
      }
      for(const row of list(record.mesh?.nodes))device(row,context);
      for(const row of list(record.hosts))device(row,context);
    }
  }
  for(const row of list(fritzbox?.mesh?.nodes))device(row,currentSnapshot);
  for(const row of list(fritzbox?.hosts))device(row,currentSnapshot);
  for(const row of list(fritzbox?.deviceTraffic))device(row,currentSnapshot);
  if(!fritzbox?.connected&&!sources.get('wan').points.length)sources.get('wan').reason='FRITZ!Box anmelden, um Router- und Geräteverkehr zu erfassen.';
  for(const source of sources.values()) {
    source.points.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
    source.latest=source.points.at(-1)||null;
    source.measured=source.points.filter(point=>finite(point.downloadMbps)||finite(point.uploadMbps)).length;
    const intervals=source.points.filter(point=>finite(point.downloadDeltaBytes)&&finite(point.uploadDeltaBytes)&&Date.parse(point.intervalStartedAt)>=Date.parse(records[0]?.at));
    source.downloadBytes=intervals.length?intervals.reduce((sum,point)=>sum+point.downloadDeltaBytes,0):null;
    source.uploadBytes=intervals.length?intervals.reduce((sum,point)=>sum+point.uploadDeltaBytes,0):null;
  }
  return [...sources.values()];
}

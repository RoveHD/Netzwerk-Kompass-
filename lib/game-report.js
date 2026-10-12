const list=value=>Array.isArray(value)?value:[];
const number=value=>Number.isFinite(value)&&value>=0?value:null;
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;

// No process IDs, paths, executable names, endpoint addresses or packet payloads.
export function gameReport(state,records,clean) {
  const game=value=>({name:clean(value?.name,80),source:['steam','epic','known','custom'].includes(value?.source)?value.source:null,startedAt:date(value?.startedAt),lastSeenAt:date(value?.lastSeenAt),endedAt:date(value?.endedAt)});
  return {
    detectionStatus:['checking','ready','partial','error','disabled','unsupported'].includes(state.gameDetection?.status)?state.gameDetection.status:null,
    active:list(state.gameDetection?.active).slice(0,8).map(game),
    observations:list(records).filter(record=>record.type==='event'&&record.kind==='game').slice(-20).map(record=>({at:date(record.at),action:['started','ended','observation-ended'].includes(record.action)?record.action:null,...game(record.game)})),
    packetCaptures:list(records).filter(record=>record.type==='event'&&record.kind==='game-packets').slice(-8).map(record=>({game:clean(record.game?.name,80),startedAt:date(record.capture?.startedAt),endedAt:date(record.capture?.endedAt),status:clean(record.capture?.status,30),quality:['unknown','observed','incomplete'].includes(record.capture?.quality)?record.capture.quality:'unknown',...Object.fromEntries(['sampleIntervalMs','sentPackets','receivedPackets','sentBytes','receivedBytes','retransmits'].map(key=>[key,number(record.capture?.[key])])),losses:{events:number(record.capture?.losses?.events),buffers:number(record.capture?.losses?.buffers)},deliveryBeyondRouter:'unknown'})),
    limits:['Spielzeiten sind beobachtete Prozesszeiten, keine bestätigten Matchzeiten.','Sende-/Empfangszähler zählen Windows-Netzwerkereignisse, keine garantierte Zahl physischer Pakete.','PC-Sendeereignisse bestätigen weder Verlassen des Heimnetzes noch Zustellung am Spielserver.','Parallel gemessene Router-/Internet-Pings sind unabhängiger Kontext; UDP-Sende-/Empfangsdifferenzen sind keine Paketverlustrate.'],
  };
}

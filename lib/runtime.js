import path from 'node:path';
import { createInterface } from 'node:readline';

export function dataDirectory(appDirectory, env=process.env) {
  const configured=env.NETZWERK_KOMPASS_DATA_DIR;
  if(!configured)return path.join(appDirectory,'data');
  if(!path.isAbsolute(configured))throw new Error('Der portable Datenordner muss ein absoluter Pfad sein.');
  return path.resolve(configured);
}

// The portable launcher owns stdin. Losing that pipe must also stop monitoring.
export function attachLauncherShutdown(input,onShutdown) {
  const lines=createInterface({input,terminal:false});
  let stopped=false;
  const stop=reason=>{if(!stopped){stopped=true;onShutdown(reason);}};
  const onInputError=()=>stop('launcher_lost');
  lines.on('line',line=>{
    if(line==='shutdown:windows_shutdown')stop('windows_shutdown');
    else if(line==='shutdown')stop('normal');
  });
  lines.once('close',()=>stop('launcher_lost'));
  input.once('error',onInputError);
  return ()=>{stopped=true;input.removeListener('error',onInputError);lines.close();};
}

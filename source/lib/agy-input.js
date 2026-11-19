'use strict';
const flags = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
function input(text) {
  return JSON.stringify({ event: 'user', message: { content: text } }) + '\n';
}
function readEvent(event) {
  if (!event || typeof event.event !== 'string') throw new Error('Invalid agy stream event.');
  if (event.event !== 'result') return null;
  if (event.result?.status !== 'SUCCESS' || typeof event.result.response !== 'string') throw new Error('agy turn failed.');
  return event.result.response;
}
function response(output) {
  let result = null;
  for (const line of output.split('\n').filter(line => line.trim())) {
    const text = readEvent(JSON.parse(line));
    if (text !== null) {
      if (result !== null) throw new Error('Unexpected second agy result.');
      result = text;
    }
  }
  if (result === null) throw new Error('Missing agy result.');
  return result.trim();
}
function prepared(executable, task, writeMode, model) {
  const cmd = [executable, ...flags, ...(writeMode ? ['--yolo'] : []), ...(model ? ['--model', model] : [])].join(' ');
  const event = input(task).trimEnd();
  if (process.platform === 'win32') return "& { $OutputEncoding = [Text.UTF8Encoding]::new($false)\n@'\n" + event + "\n'@ | " + cmd + "\n}";
  return cmd + " <<'LEERNESS_AGY_INPUT'\n" + event + "\nLEERNESS_AGY_INPUT";
}
module.exports = { flags, input, readEvent, response, prepared };

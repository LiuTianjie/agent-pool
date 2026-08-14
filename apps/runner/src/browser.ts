import { spawn } from 'node:child_process';

export function openBrowser(url: string): boolean {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

  const command =
    process.platform === 'darwin'
      ? { executable: 'open', args: [parsed.toString()] }
      : process.platform === 'win32'
        ? {
            executable: 'rundll32.exe',
            args: ['url.dll,FileProtocolHandler', parsed.toString()],
          }
        : { executable: 'xdg-open', args: [parsed.toString()] };
  try {
    const child = spawn(command.executable, command.args, {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

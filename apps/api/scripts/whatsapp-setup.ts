/**
 * Configura a instância da Evolution API: cria (se preciso), aponta o webhook para a API e salva
 * o QR code para parear o WhatsApp em data/whatsapp-qr.png.
 *   pnpm whatsapp:setup
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EvolutionChannel } from '../src/channels/evolution.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
if (!config.EVOLUTION_API_KEY) throw new Error('Defina EVOLUTION_API_KEY no .env');
if (!config.EVOLUTION_WEBHOOK_SECRET) throw new Error('Defina EVOLUTION_WEBHOOK_SECRET no .env');
const evo = new EvolutionChannel({
  baseUrl: config.EVOLUTION_URL,
  apiKey: config.EVOLUTION_API_KEY,
  instance: config.EVOLUTION_INSTANCE,
});
const webhook = `${config.EVOLUTION_WEBHOOK_URL}/webhooks/evolution/${config.EVOLUTION_WEBHOOK_SECRET}`;

await evo.ensureInstance(webhook);
console.log(
  `Instância "${config.EVOLUTION_INSTANCE}" pronta; webhook → ${webhook.replace(config.EVOLUTION_WEBHOOK_SECRET, '***')}`,
);
const state = await evo.connectionState();
console.log(`Estado da conexão: ${state}`);
if (state !== 'open') {
  const qr = await evo.qrCode();
  if (qr) {
    const out = path.resolve(process.cwd(), '../../data/whatsapp-qr.png');
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, Buffer.from(qr.replace(/^data:image\/png;base64,/, ''), 'base64'));
    console.log(`Escaneie o QR code em ${out} (WhatsApp → Aparelhos conectados → Conectar aparelho).`);
  } else {
    console.log('Não recebi QR code; confira os logs da Evolution API.');
  }
}

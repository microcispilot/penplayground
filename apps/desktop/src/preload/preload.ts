import { contextBridge } from 'electron';

/** The only bridge the renderer gets: platform facts, no Node access. */
contextBridge.exposeInMainWorld('pen', {
  platform: 'desktop' as const,
  apiUrl: process.env.PEN_API_URL ?? 'https://api.penplayground.com',
  os: process.platform,
});

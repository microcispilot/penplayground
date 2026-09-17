import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import type { ForgeConfig } from '@electron-forge/shared-types';

/**
 * Packaging for macOS / Windows / Linux. Shape follows Simurgh's desktop
 * (Vite plugin for main/preload/renderer, fuses hardening, signing behind
 * platform checks). Signing identities come from CI secrets, never the repo.
 */
const config: ForgeConfig = {
  packagerConfig: {
    name: 'Pen Academy',
    executableName: 'pen-academy',
    appBundleId: 'ai.penacademy.desktop',
    asar: true,
    ...(process.platform === 'darwin' && process.env.APPLE_ID
      ? {
          osxSign: {},
          osxNotarize: {
            appleId: process.env.APPLE_ID ?? '',
            appleIdPassword: process.env.APPLE_APP_PASSWORD ?? '',
            teamId: process.env.APPLE_TEAM_ID ?? '',
          },
        }
      : {}),
    extendInfo: {
      NSMicrophoneUsageDescription:
        'Pen Academy listens so you can interrupt the expert and ask questions by voice.',
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    new MakerDMG({}),
    new MakerZIP({}, ['darwin']),
    new MakerDeb({}),
    new MakerRpm({}),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/main.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;

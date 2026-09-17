import { describe, expect, it } from 'vitest';
import {
  buildAudioFilter,
  buildBlackdetectArgs,
  buildMuxArgs,
  buildVideoFilter,
  chooseCurtain,
  ffmpegVersionOk,
  ffprobePathFor,
  parseBlackIntervals,
  parseFfmpegVersion,
} from '../src/export/ffmpeg.js';
import { alignToTape, exportFilename } from '../src/export/plan.js';

const says = [
  { sayId: 'L0.s1', take: 0, offsetMs: 0, pcmPath: '/a/L0.s1.0.pcm', durationMs: 3200 },
  { sayId: 'L0.s2', take: 1, offsetMs: 3212.4, pcmPath: '/a/L0.s2.1.pcm', durationMs: 2500 },
  {
    sayId: 't1.s1',
    take: 0,
    offsetMs: 5730,
    pcmPath: '/a/t1.s1.0.pcm',
    durationMs: 1800,
    sampleRate: 24000 as const,
  },
];

describe('export ffmpeg builder', () => {
  it('places every say at its video offset with adelay, trimmed to the ledger length, and mixes without normalisation', () => {
    const { filter, label } = buildAudioFilter(says);
    expect(label).toBe('[a]');
    expect(filter).toBe(
      [
        '[1:a]atrim=end=3.200,aresample=44100,adelay=delays=0:all=1[d0]',
        '[2:a]atrim=end=2.500,aresample=44100,adelay=delays=3212:all=1[d1]',
        '[3:a]atrim=end=1.800,aresample=44100,adelay=delays=5730:all=1[d2]',
        '[d0][d1][d2]amix=inputs=3:normalize=0:dropout_transition=0,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,apad[a]',
      ].join(';'),
    );
  });

  it('substitutes stereo silence when nothing was spoken', () => {
    expect(buildAudioFilter([]).filter).toBe('anullsrc=r=44100:cl=stereo[a]');
  });

  it('never emits a negative delay', () => {
    const one = [{ ...says[0], offsetMs: -12 }] as typeof says;
    expect(buildAudioFilter(one).filter).toContain('adelay=delays=0:all=1');
  });

  it('trims the video at the sync curtain and normalises to 1280x720 @ 30 fps yuv420p', () => {
    expect(buildVideoFilter(1.2)).toBe(
      '[0:v]trim=start=1.200,setpts=PTS-STARTPTS,fps=30,scale=1280:720:flags=lanczos,format=yuv420p[v]',
    );
  });

  it('declares each raw PCM input with its own sample rate and muxes H.264 + AAC with faststart', () => {
    const args = buildMuxArgs({
      videoPath: '/tmp/v.webm',
      videoStartSec: 0.8,
      durationSec: 8.53,
      says,
      outputPath: '/out/export.mp4',
    });
    // Input 0 is the video; PCM inputs follow in say order with their format declared before `-i`.
    expect(args.slice(0, 10)).toEqual([
      '-hide_banner',
      '-nostdin',
      '-nostats',
      '-loglevel',
      'error',
      '-progress',
      'pipe:1',
      '-y',
      '-i',
      '/tmp/v.webm',
    ]);
    expect(args.join(' ')).toContain('-f s16le -ar 44100 -ac 1 -i /a/L0.s1.0.pcm');
    expect(args.join(' ')).toContain('-f s16le -ar 44100 -ac 1 -i /a/L0.s2.1.pcm');
    expect(args.join(' ')).toContain('-f s16le -ar 24000 -ac 1 -i /a/t1.s1.0.pcm');
    const graph = args[args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph.startsWith('[0:v]trim=start=0.800,')).toBe(true);
    expect(graph).toContain('amix=inputs=3:normalize=0');
    expect(args).toContain('-map');
    expect(args[args.indexOf('-map') + 1]).toBe('[v]');
    expect(args[args.lastIndexOf('-map') + 1]).toBe('[a]');
    expect(args[args.indexOf('-t') + 1]).toBe('8.530');
    for (const pair of [
      ['-c:v', 'libx264'],
      ['-preset', 'veryfast'],
      ['-crf', '22'],
      ['-pix_fmt', 'yuv420p'],
      ['-r', '30'],
      ['-c:a', 'aac'],
      ['-ar', '44100'],
      ['-ac', '2'],
      ['-movflags', '+faststart'],
    ]) {
      // Output options come after every input's own `-ar`/`-ac`.
      expect(args[args.lastIndexOf(pair[0] ?? '') + 1]).toBe(pair[1]);
    }
    expect(args.slice(-3)).toEqual(['-f', 'mp4', '/out/export.mp4']);
  });

  it('parses blackdetect intervals from ffmpeg stderr', () => {
    const stderr = [
      'Input #0, matroska,webm, from v.webm:',
      '[blackdetect @ 0x1] black_start:0.36 black_end:1.24 black_duration:0.88',
      'frame=  120 fps=0.0 q=-0.0 size=N/A',
      '[blackdetect @ 0x1] black_start:12.6 black_end:13.28 black_duration:0.68',
    ].join('\n');
    expect(parseBlackIntervals(stderr)).toEqual([
      { startSec: 0.36, endSec: 1.24 },
      { startSec: 12.6, endSec: 13.28 },
    ]);
    expect(parseBlackIntervals('nothing here')).toEqual([]);
  });

  it('runs blackdetect with no audio and a null muxer', () => {
    const args = buildBlackdetectArgs('/tmp/v.webm');
    expect(args).toContain('-an');
    expect(args.slice(-2)).toEqual(['null', '-']);
    expect(args[args.indexOf('-vf') + 1]).toMatch(/^blackdetect=/);
  });

  it('derives ffprobe from the ffmpeg path and slugs titles for the download name', () => {
    expect(ffprobePathFor('/opt/homebrew/bin/ffmpeg')).toBe('/opt/homebrew/bin/ffprobe');
    expect(ffprobePathFor('ffmpeg')).toBe('ffprobe');
    expect(ffprobePathFor('C:\\tools\\ffmpeg.exe')).toBe('C:\\tools\\ffprobe.exe');
    expect(exportFilename('How Transformers Work in LLMs')).toBe(
      'pen-how-transformers-work-in-llms.mp4',
    );
    expect(exportFilename('  Ünïcode — “quotes” & more!  ')).toBe('pen-unicode-quotes-more.mp4');
    expect(exportFilename('')).toBe('pen-session.mp4');
    expect(exportFilename('x'.repeat(200)).length).toBeLessThanOrEqual('pen-.mp4'.length + 60);
  });
});

describe('alignToTape', () => {
  it('passes offsets through when no drift was measured', () => {
    expect(alignToTape([0, 4000, 8000], 10_000, null)).toEqual([0, 4000, 8000]);
  });

  it('stretches offsets linearly so the last one lands where the trailing curtain did', () => {
    // Page said done at 40 000 ms; the tape shows the curtain 166 ms later.
    const tape = alignToTape([0, 10_000, 20_000, 40_000], 40_000, 166);
    expect(tape).toEqual([0, 10_042, 20_083, 40_166]);
  });

  it('shrinks offsets when the tape ran short', () => {
    expect(alignToTape([0, 20_000], 20_000, -100)).toEqual([0, 19_900]);
  });

  it('never divides by zero on an empty recording', () => {
    expect(alignToTape([0], 0, 50)).toEqual([0]);
  });
});

describe('chooseCurtain', () => {
  const lead = { startSec: 0.4, endSec: 1.2 };
  const tail = { startSec: 29.4, endSec: 30.1 };

  it('takes the first interval as the lead and the matching closing curtain as the tail', () => {
    expect(chooseCurtain([lead, tail], 28_166)).toEqual({ lead, tail });
  });

  it('ignores padding black before the app painted and a short flicker in the middle', () => {
    const pad = { startSec: 0, endSec: 0.24 };
    const flicker = { startSec: 12, endSec: 12.05 };
    expect(chooseCurtain([pad, lead, flicker, tail], 28_166)).toEqual({ lead, tail });
  });

  it('keeps the lead but reports no tail when nothing plausible closes the export', () => {
    const early = { startSec: 5, endSec: 5.5 };
    expect(chooseCurtain([lead, early], 28_166)).toEqual({ lead, tail: null });
  });

  it('is null with no black at all', () => {
    expect(chooseCurtain([], 1000)).toBeNull();
  });
});

describe('ffmpeg version gate', () => {
  it('parses distro and upstream banners', () => {
    expect(parseFfmpegVersion('ffmpeg version 8.1.1 Copyright (c) 2000-2026')).toEqual([8, 1]);
    expect(parseFfmpegVersion('ffmpeg version n6.1.1-3ubuntu5')).toEqual([6, 1]);
    expect(parseFfmpegVersion('ffmpeg version 4.2.7-0ubuntu0.1')).toEqual([4, 2]);
    expect(parseFfmpegVersion('garbage')).toBeNull();
  });
  it('requires 4.4 or newer', () => {
    expect(ffmpegVersionOk([4, 4])).toBe(true);
    expect(ffmpegVersionOk([8, 1])).toBe(true);
    expect(ffmpegVersionOk([4, 2])).toBe(false);
    expect(ffmpegVersionOk(null)).toBe(false);
  });
});

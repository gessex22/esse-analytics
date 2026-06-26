import { platformVideoRepo } from '../db/platform-video.repo';

// Instagram — último video de la cuenta
platformVideoRepo.upsert({
  platform:     'instagram',
  platform_id:  '18196138804373891',
  platform_url: 'https://www.instagram.com/reel/DaCP6bOEj8-/',
  published_at: new Date('2026-06-26T04:09:11+0000'),
  match_status: 'remote',
  title:        '¿El gobierno de EE.UU. contra la #InteligenciaArtificial?',
});
console.log('✅ Instagram insertado');

// YouTube — último video del canal
platformVideoRepo.upsert({
  platform:     'youtube',
  platform_id:  'G0WcpyUPRKM',
  platform_url: 'https://www.youtube.com/watch?v=G0WcpyUPRKM',
  published_at: new Date('2026-06-25T06:50:07Z'),
  match_status: 'remote',
  title:        'El caos de discord',
});
console.log('✅ YouTube insertado');

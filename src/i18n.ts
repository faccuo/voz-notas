// Tiny i18n helper. English is the default (this plugin is meant for the
// community); Spanish is available and switchable in settings.

export type Lang = 'en' | 'es'

type Dict = Record<string, string>

const STRINGS: Record<Lang, Dict> = {
  en: {
    'orb.idle': 'Press to connect',
    'orb.connecting': 'Connecting…',
    'orb.live': 'Listening · tap to mute',
    'orb.muted': 'Muted · tap to talk',
    'orb.aria': 'Press to connect · click while live to mute',
    'panel.consulted': 'Consulted',
    'notice.setKey': 'Set your OpenAI API key in voz-notas settings first.',
    'notice.preparing': 'Preparing your notes…',
    'notice.connected': 'Connected — talk to your notes!',
    'notice.ended': 'Voice session ended.',
    'notice.startFirst': 'Start a voice session first.',
    'notice.error': 'Voice error: {0}',
    'settings.language.name': 'Language',
    'settings.language.desc': 'Language of the plugin interface.',
  },
  es: {
    'orb.idle': 'Pulsa para conectar',
    'orb.connecting': 'Conectando…',
    'orb.live': 'Escuchando · toca para silenciar',
    'orb.muted': 'Silenciado · toca para hablar',
    'orb.aria': 'Pulsa para conectar · haz clic en directo para silenciar',
    'panel.consulted': 'Consultado',
    'notice.setKey': 'Añade tu clave de OpenAI en los ajustes de voz-notas primero.',
    'notice.preparing': 'Preparando tus notas…',
    'notice.connected': '¡Conectado — habla con tus notas!',
    'notice.ended': 'Sesión de voz terminada.',
    'notice.startFirst': 'Arranca una sesión de voz primero.',
    'notice.error': 'Error de voz: {0}',
    'settings.language.name': 'Idioma',
    'settings.language.desc': 'Idioma de la interfaz del plugin.',
  },
}

let current: Lang = 'en'

export function setLang(lang: Lang) {
  current = STRINGS[lang] ? lang : 'en'
}

export function t(key: string, ...args: string[]): string {
  const s = STRINGS[current][key] ?? STRINGS.en[key] ?? key
  return args.length ? s.replace(/\{(\d+)\}/g, (_, i) => args[Number(i)] ?? '') : s
}

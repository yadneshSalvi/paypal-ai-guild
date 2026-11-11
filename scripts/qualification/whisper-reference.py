from pathlib import Path
import importlib.util,sys,json,hashlib,importlib.metadata
folder=Path(__file__).resolve().parents[2]
vendor=folder/'vendor'/'whisper'
(vendor/'assets').mkdir(exist_ok=True)
asset=vendor/'assets'/'multilingual.tiktoken'
if not asset.exists(): asset.symlink_to('../multilingual.tiktoken')
spec=importlib.util.spec_from_file_location('guild_whisper_reference',vendor/'tokenizer.py')
mod=importlib.util.module_from_spec(spec);sys.modules[spec.name]=mod;spec.loader.exec_module(mod)
encoder=mod.get_encoding('multilingual')
texts={
 'en':'At the harbor, the photograph records a quiet morning. It does not identify every person.',
 'pt':'No porto, a fotografia registra uma manhã tranquila. Não identifica todas as pessoas.',
 'es':'En el puerto, la fotografía registra una mañana tranquila. No identifica a todas las personas.',
 'fr':'Au port, la photographie montre un matin calme. Elle ne permet pas d’identifier toutes les personnes.',
 'ja':'港の写真には静かな朝が写っています。すべての人物の名前が分かるわけではありません。',
 'ar':'تُسجِّلُ الصُّورةُ صباحًا هادئًا في الميناء. لا نعرفُ أسماءَ جميعِ الأشخاصِ.',
}
cases=[]
for locale,text in texts.items():
 for kind,value in [('short',text),('long',(text+' ')*25),('leading-space',' '+text),('decomposed',__import__('unicodedata').normalize('NFD',text)),('newlines',text+'\n\n'+text)]:
  cases.append({'locale':locale,'kind':kind,'text':value,'tokens':encoder.encode(value)})
for value in ["I'm not sure; I’M not sure. 0123456789 ١٢٣٤٥",'é e\u0301 Å A\u030A café','Hello\tthere.\r\nAnother line.','日本語、句読点。カタカナ １２３','𐐀𐐨 test 🏛️ museum','¡Hola! ¿Quién vino? «Merci» — obrigado.']:
 cases.append({'locale':'en','kind':'unicode-reference','text':value,'tokens':encoder.encode(value)})
report={'version':'guild.whisper-tokenizer-reference.v1','sourceCommit':'86098128c0b4f24f0e2aa2994de830614b474227','python':sys.version.split()[0],'tiktoken':importlib.metadata.version('tiktoken'),'regex':importlib.metadata.version('regex'),'ranksSha256':hashlib.sha256((vendor/'multilingual.tiktoken').read_bytes()).hexdigest(),'cases':cases}
(folder/'tests/fixtures/whisper-reference-vectors.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k!='cases'}|{'referenceCases':len(cases)}))

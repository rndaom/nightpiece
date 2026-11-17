/**
 * What a name looks like, as against what it is written with. A name is never changed by any of
 * this: it is only what a name is compared by when it is checked against a list of names nobody
 * may take, so that one written with another alphabet's letters, or with digits for letters, is
 * read as the word it shows.
 */

/**
 * Letters of any script that are drawn like a plain Latin letter, under the letter they pass for.
 * From the Unicode Consortium's list of confusable characters (Unicode Technical Standard #39,
 * confusables.txt), with the small capitals read as the letters they are drawn as. Letters that
 * come apart into a plain letter and its accents are not here: they are taken apart first.
 */
const DRAWN_AS: Record<string, string> = {
  a: 'ɑΑαАаᎪᏎᗅᴀꓮꭤꭺꮞ𐊠𑢯𖽀',
  b: 'ƀƂƃƄƅȢȣɓʙΒβБВЬвьѢѣҌҍᏏᏴᏼᑲᑳᖯᗷⲂⲃꓐꕗꖉꞴꮟ𐊂𐊡𐌁𐌚𐌜𖧾',
  c: 'ȼςСсҪҫငၚᏟᲃᴄⲤⲥꓚꮯ𐊢𐌂𐐕𐐽𐔛',
  d: 'ÐĐđƉƋƌɖɗԁᎠᏧᑯᗞᗪᴅꓒꓓꭰ',
  e: 'ƷȜɆɇΕεЕЗеҘҽҿӠՅᎬᜂᲕᴇⲜⳄⳌⴹꓰꗋꝪꞫꣶꬲꭼ𐊆𑢦𑢮𑣊𖼻',
  f: 'ƑƒʄϜքᖴᵮẝꓝꜰꞘꞙꬵ𐊇𐊥𐔥𑢢𑣂',
  g: 'ƍǤǥɠɡɢԌԍցᏀᏳᏻᶃⳊⳋꓖꝮꝯꮐ𑢬𑣌𑣖𖧁',
  h: 'ĦħɦʜΗНнћҢңҺһӇӈӉӊհႹᎻᏂᏲᕼⱧⲎⲏꓧꚕꮋ𐋏',
  i: 'ıɨɩɪιіւᎥᵻᵼⲓꙇꭵ𑣃',
  j: 'ȷɈɉɟͿϳЈјյᎫᒍᴊꓙꞲꭻ',
  k: 'ĸƙΚκКкҚқҞҟᏦᛕᴋⱩⲔⲕꓗꝀꮶ𐔘',
  l: 'ŁłƖƗƚǀɫɭʟΙІӀӏᏞᒪᛁᛅᛐⲒⳐⳑⵊⵏꓡꓲꕯꞁꞮꟾꮮ𐊊𐌉𐐛𐑃𐔎𐔦𑢣𑢲𖫤𖵣𖼖𖼨',
  m: 'ʍΜϺМмӍӎᎷᗰᛖᴍⲘⲙꓟꮇ𐊰𐌑',
  n: 'ŋƝƞɲɳɴͷΝηπипҋղոռᴎᴨᵰⲚⲛⲡꓠ𐑍𐔓𑪾',
  o: 'ØøƟɵΘΟθοσϭОоѲѳӨөՕօଠഠတဝთჿᄋᆼዐፀᎤᎾᏫᨲᩅᲂᲿᴏᴑⲐⲑⲞⲟⴱⵁⵔꓳꚢꝊꝋꬽꬾꭴꮎꮻ𐊒𐊫𐌏𐐄𐐬𐓂𐓪𐔖𐔞𑄖𑄤𑢵𑣈𑣗𖦛𖫩',
  p: 'þƥƿΡρϸРрᏢᑭᴘᴩᵽⲢⲣⳎⳏꓑꮲ𐊕',
  q: 'ʠԚԛգզⵕꞯ',
  r: 'ƦɌɍɼɽʀгяғᎡᏒᖇᴙᴦᵲⲅꓣꭇꭈꭱꮁꮢ𐒴𖨙𖼵',
  s: 'ƼƽʂЅѕՏടႽჽᏕᏚᲽᵴꓢꕶꜱꟅꮪ𐊖𐐠𐑈𑢻𑣁𖫖𖼺',
  t: 'ŦŧƫƭƮȾΤτТтҬҭᎢᎿᜪᲄᴛᵵⲦⲧㄒ丅ꓔꔋꚌꚍꭲ𐊗𐊱𐌕𐓒𑢼𑣆𖼊',
  u: 'ɄʋμυџՍսሀᏌᑌᴜᵾꓴꞟꭎꭒꮜ𐓎𐓶𑢸𑣘𖽂',
  v: 'νѴѵᏙᐯᴠⴸꓦꛟꮩ𐔝𑜆𑢠𑣀𖼈',
  w: 'ɯωшѡѽԜԝաᎳᏔᴡⲽꓪꝡꟺꮃꮤ𑓅𑜊𑜎𑜏',
  x: 'ΧχХхҲᕁᕽᚷᝣᳵⲬⵝꓫꞳ𐊐𐊴𐌗𐔧',
  y: 'ƴɎɏɣʏΥγУуҮүҰұყᎩᎽᶌỿⲨⲩㄚ丫ꓬꚲꭚ𐊲𑢤𑣄𑣜𖽃',
  z: 'ƵƶȤȥʐΖჍᏃᴢᵶⱫⱬⲌⲍⴭꓜꛉꮓ𐔇𑢩𑪼',
};

/** The digits written for letters: 4dm1n, m0d. */
const DIGIT_AS: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g' };

const LOOKALIKE = new Map<string, string>();
for (const [letter, alike] of Object.entries(DRAWN_AS)) for (const one of alike) LOOKALIKE.set(one, letter);

/** Whether a letter of another script is drawn like a Latin one. */
export function passesForLatin(letter: string): boolean {
  return LOOKALIKE.has(letter);
}

/**
 * A name as it reads: small letters only, accents off, every letter that is drawn like a plain
 * Latin one put down as that one, and a small L as an I (a capital I and a small L are one stroke
 * each). Digits are read as the letters they are written for, or, if `digits` is false, left out.
 */
export function readAs(name: string, digits = true): string {
  let out = '';
  for (const one of name.normalize('NFKD')) {
    const as = LOOKALIKE.get(one) ?? (digits ? DIGIT_AS[one] : undefined) ?? one.toLowerCase();
    for (const letter of as) if (/\p{L}/u.test(letter)) out += letter === 'l' ? 'i' : letter;
  }
  return out;
}

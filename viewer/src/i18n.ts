// All text shown in the user interface, in every language, in one place.
//
// To add a language, add it to LANGS: the type check (npm run typecheck) then lists
// every string that still needs a translation, and the flag. Texts may hold {name} placeholders,
// filled in by t(key, { name: value }). Keyboard shortcuts are the same in every language.

export const LANGS = { en: 'English', nb: 'Norsk' } as const
export type Lang = keyof typeof LANGS

/**
 * The flag on each language's button on the start screen, as SVG (flag emoji are letters on
 * Windows). All are drawn at 3:2, so the buttons have the same size.
 */
const FLAGS: Record<Lang, string> = {
  en:
    '<svg viewBox="0 0 60 40"><clipPath id="flag-en-clip"><path d="M30 20h30v20zv20H0zH0V0zV0h30z"/></clipPath>' +
    '<path d="M0 0h60v40H0z" fill="#012169"/>' +
    '<path d="M0 0l60 40m0-40L0 40" stroke="#fff" stroke-width="8"/>' +
    '<path d="M0 0l60 40m0-40L0 40" clip-path="url(#flag-en-clip)" stroke="#c8102e" stroke-width="5"/>' +
    '<path d="M30 0v40M0 20h60" stroke="#fff" stroke-width="13"/>' +
    '<path d="M30 0v40M0 20h60" stroke="#c8102e" stroke-width="8"/></svg>',
  nb:
    '<svg viewBox="0 0 24 16"><path d="M0 0h24v16H0z" fill="#ba0c2f"/>' +
    '<path d="M6 0h4v16H6zM0 6h24v4H0z" fill="#fff"/>' +
    '<path d="M7 0h2v16H7zM0 7h24v2H0z" fill="#00205b"/></svg>',
}

const STRINGS = {
  // Start screen.
  tagline: {
    en: 'Orienteering in real terrain, in 3D on your computer',
    nb: 'Orientering i ekte terreng, i 3D på datamaskinen',
  },
  worldLabel: { en: 'Map', nb: 'Kart' },
  languageLabel: { en: 'Language', nb: 'Språk' },
  courseFileButton: { en: 'Open course file …', nb: 'Åpne løypefil …' },
  courseFileTitle: { en: 'An OCAD course setting file (.ocd)', nb: 'En OCAD-fil med løyper (.ocd)' },
  courseLabel: { en: 'Course', nb: 'Løype' },
  chooseCourse: { en: 'Choose a course', nb: 'Velg løype' },
  raceLabel: { en: 'Race', nb: 'Løp' },
  chooseRace: { en: 'Choose a race', nb: 'Velg løp' },
  startButton: { en: 'Click to start', nb: 'Klikk for å starte' },
  starting: { en: 'Starting …', nb: 'Starter …' },
  keyNameMouse: { en: 'Mouse', nb: 'Mus' },
  keyMove: { en: 'move', nb: 'gå' },
  keyLook: { en: 'look around', nb: 'se deg rundt' },
  keyTime: { en: 'time factor up / down (game time runs faster)', nb: 'tidsfaktor opp / ned (spilltida går fortere)' },
  keyFly: { en: 'fly on/off (look up or down to climb or dive)', nb: 'fly av/på (se opp eller ned for å stige eller dykke)' },
  keyMap: {
    en: 'map: drag, wheel zoom, click to put the thumb (competition mode), double click to go there',
    nb: 'kart: dra, rulle for zoom, klikk for å sette tommelen (konkurransemodus), dobbeltklikk for å gå dit',
  },
  keyNameMouseMap: { en: 'Mouse, map open', nb: 'Mus, kart oppe' },
  keyMapSteering: {
    en: 'while steering: hold the left button to move the map, the right to move the thumb (competition mode); wheel turns the map',
    nb: 'når du styrer: hold venstre knapp for å flytte kartet, høyre for å flytte tommelen (konkurransemodus); rulle vrir kartet',
  },
  keyStart: { en: 'go to the start · R restart the run', nb: 'gå til start · R start løpet på nytt' },
  keyStartScreen: { en: 'pause, on the start screen: choose map and course', nb: 'pause, på startsida: velg kart og løype' },
  keyDescriptions: { en: 'control descriptions on/off', nb: 'postbeskrivelse av/på' },
  keyGroundMap: { en: 'orienteering map on the ground on/off', nb: 'o-kartet på bakken av/på' },
  keyQuality: { en: 'graphics quality (shadows)', nb: 'grafikkvalitet (skygger)' },
  keyPause: {
    en: 'pause; while steering with the map open, the first Esc gives the mouse to the map',
    nb: 'pause; når du styrer med kartet oppe, gir første Esc musa til kartet',
  },
  resumeHint: {
    en: 'Click the terrain to steer with the mouse · Esc or H: pause · W A S D to run',
    nb: 'Klikk i terrenget for å styre med musa · Esc eller H: pause · W A S D for å løpe',
  },

  // Loading.
  noWorlds: { en: 'No worlds found. Build one first:\n  uv run terraino build <map.ocd>', nb: 'Fant ingen verdener. Bygg en først:\n  uv run terraino build <kart.ocd>' },
  loadingWorld: { en: 'Loading {name} …', nb: 'Laster {name} …' },
  loadingTerrain: { en: 'Loading terrain {percent} %', nb: 'Laster terreng {percent} %' },
  paintingTextures: { en: 'Painting textures …', nb: 'Maler teksturer …' },
  preparingTerrain: { en: 'Preparing terrain …', nb: 'Klargjør terrenget …' },
  plantingTrees: { en: 'Planting trees …', nb: 'Planter trær …' },
  buildingWorld: { en: 'Laying out roads, buildings and rocks …', nb: 'Legger veier, bygninger og steiner …' },
  compilingShaders: { en: 'Preparing graphics …', nb: 'Klargjør grafikken …' },
  error: { en: 'Error: {message}', nb: 'Feil: {message}' },

  // Course files.
  readingCourses: { en: 'Reading {file} …', nb: 'Leser {file} …' },
  coursesFound: { en: '{count} courses in {file}', nb: '{count} løyper i {file}' },
  courseChosen: { en: '{name}: {controls} controls, {length} km', nb: '{name}: {controls} poster, {length} km' },
  notOcad: { en: 'This is not an OCAD file', nb: 'Dette er ikke en OCAD-fil' },
  ocadVersion: {
    en: 'OCAD {version} files are not supported; save the file with OCAD 12 or newer',
    nb: 'OCAD {version}-filer støttes ikke; lagre fila med OCAD 12 eller nyere',
  },
  noCourses: { en: 'The file has no courses', nb: 'Fila har ingen løyper' },
  wrongZone: {
    en: 'The course file is in UTM zone {course}, the map in zone {map}',
    nb: 'Løypefila er i UTM-sone {course}, kartet i sone {map}',
  },
  outsideMap: { en: 'The course "{name}" is outside this map', nb: 'Løypa «{name}» ligger utenfor dette kartet' },

  // Status line and information.
  treesStatus: { en: '{near} near / {total} trees · {quality} quality', nb: '{near} nære / {total} trær · {quality} kvalitet' },
  qualityHigh: { en: 'high', nb: 'høy' },
  qualityMedium: { en: 'medium', nb: 'middels' },
  qualityLow: { en: 'low', nb: 'lav' },
  infoHeight: { en: 'Height {height} m · {pace} min/km', nb: 'Høyde {height} m · {pace} min/km' },
  infoFlying: { en: ' · flying', nb: ' · flyr' },
  infoRunnability: { en: 'Runnability {percent} %', nb: 'Løpbarhet {percent} %' },

  // Compass.
  compassN: { en: 'N', nb: 'N' },
  compassNE: { en: 'NE', nb: 'NØ' },
  compassE: { en: 'E', nb: 'Ø' },
  compassSE: { en: 'SE', nb: 'SØ' },
  compassS: { en: 'S', nb: 'S' },
  compassSW: { en: 'SW', nb: 'SV' },
  compassW: { en: 'W', nb: 'V' },
  compassNW: { en: 'NW', nb: 'NV' },

  // Map window.
  map: { en: 'Map', nb: 'Kart' },
  closeMap: { en: 'Close the map (M)', nb: 'Lukk kartet (M)' },
  startScreen: {
    en: 'Back to the start screen: choose map and course (H)',
    nb: 'Tilbake til startsida: velg kart og løype (H)',
  },
  rotateLeft: { en: 'Rotate anticlockwise', nb: 'Drei mot klokka' },
  rotateRight: { en: 'Rotate clockwise', nb: 'Drei med klokka' },
  northUp: { en: 'North up', nb: 'Nord opp' },
  auto: { en: 'Auto', nb: 'Auto' },
  autoTitle: { en: 'Turn the map with the direction you are running', nb: 'Snu kartet etter retningen du løper' },
  zoomOut: { en: 'Zoom out (wheel)', nb: 'Zoom ut (rulle)' },
  zoomIn: { en: 'Zoom in (wheel)', nb: 'Zoom inn (rulle)' },
  whole: { en: 'Whole', nb: 'Hele' },
  wholeTitle: { en: 'Show the whole map', nb: 'Vis hele kartet' },
  me: { en: 'Me', nb: 'Meg' },
  legs: { en: 'Legs', nb: 'Strekk' },
  legsTitle: { en: 'Show the leg you are on and the next one', nb: 'Vis strekket du er på og det neste' },
  meTitle: { en: 'Centre on your position', nb: 'Midtstill på der du er' },
  position: { en: 'Position', nb: 'Posisjon' },
  setCourse: { en: 'Set course', nb: 'Legg løype' },
  setCourseTitle: {
    en: 'Click on the map to place start, controls and finish (N)',
    nb: 'Klikk på kartet for å sette start, poster og mål (N)',
  },
  done: { en: 'Done', nb: 'Ferdig' },
  helpEditing: {
    en: 'Click: add control · Right click / Backspace: remove last · Delete: clear · Drag: move · Wheel: zoom',
    nb: 'Klikk: ny post · Høyreklikk / Backspace: fjern siste · Delete: slett alt · Dra: flytt · Rulle: zoom',
  },
  helpMap: {
    en: 'Drag: move · Wheel: zoom · Double click: go there',
    nb: 'Dra: flytt · Rulle: zoom · Dobbeltklikk: gå dit',
  },
  // In competition mode, with the thumb.
  helpMapThumb: {
    en: 'Drag: move · Wheel: zoom · Click: thumb · Double click: go there',
    nb: 'Dra: flytt · Rulle: zoom · Klikk: tommel · Dobbeltklikk: gå dit',
  },
  helpMapSteering: {
    en: 'Hold left button: move the map · Wheel: turn the map',
    nb: 'Hold venstre knapp: flytt kartet · Rulle: vri kartet',
  },
  helpMapSteeringThumb: {
    en: 'Hold left button: move the map · Hold right button: move the thumb · Wheel: turn the map',
    nb: 'Hold venstre knapp: flytt kartet · Hold høyre knapp: flytt tommelen · Rulle: vri kartet',
  },
  linkCopied: { en: 'Link to this course copied', nb: 'Lenke til løypa kopiert' },
  competition: { en: 'Competition', nb: 'Konkurranse' },
  competitionTitle: {
    en: 'Competition mode: no position, heading, Auto, flying, jumps on the map or map on the ground during a run. Only these runs can be saved.',
    nb: 'Konkurransemodus: ingen posisjon, kurs, Auto, flyging, hopp på kartet eller kart på bakken under løpet. Bare slike løp kan lagres.',
  },
  competitionLocked: { en: 'Not during a run · R to start again', nb: 'Ikke under løpet · R for å starte på nytt' },
  notInCompetition: { en: 'Not in competition mode', nb: 'Ikke i konkurransemodus' },
  notCompetitionRun: {
    en: 'Not in competition mode: this run will not be saved. Competition is under the map.',
    nb: 'Ikke i konkurransemodus: dette løpet blir ikke lagret. Konkurranse er under kartet.',
  },

  // Competition mode tutorial (tutorial.ts): a line is a paragraph, "- " a list item.
  tutorial: { en: 'Tutorial', nb: 'Veiledning' },
  tutorialTitle: { en: 'How to run in competition mode', nb: 'Slik løper du i konkurransemodus' },
  tutorialWindow: { en: 'Running in competition mode', nb: 'Løpe i konkurransemodus' },
  tutorialBack: { en: '← Back', nb: '← Tilbake' },
  tutorialNext: { en: 'Next →', nb: 'Neste →' },
  tutorialCount: { en: '{step} of {count}', nb: '{step} av {count}' },
  tutorialAboutTitle: { en: 'Only the map and the compass', nb: 'Bare kart og kompass' },
  tutorialAbout: {
    en: [
      'Competition mode is orienteering as in a real race: you have the map and the compass, and nothing else.',
      'During the run there is:',
      '- no position on the map, and the map does not follow you',
      '- no coordinates and no heading at the top of the screen',
      '- no **Auto**: you set the map yourself',
      '- no flying, no jumps on the map and no map on the ground',
      "Only runs in competition mode go on the course's results list.",
    ].join('\n'),
    nb: [
      'Konkurransemodus er orientering som i et ekte løp: du har kart og kompass, og ikke noe mer.',
      'Under løpet er det:',
      '- ingen posisjon på kartet, og kartet følger ikke med deg',
      '- ingen koordinater og ingen kurs øverst på skjermen',
      '- ingen **Auto**: du orienterer kartet selv',
      '- ingen flyging, ingen hopp på kartet og ikke noe kart på bakken',
      'Bare løp i konkurransemodus kommer på resultatlista for løypa.',
    ].join('\n'),
  },
  tutorialBeforeTitle: { en: 'Before the start', nb: 'Før start' },
  tutorialBefore: {
    en: [
      '- Choose a map and a course on the start screen (**Open course file …**), or set a course yourself on the map (**Set course**).',
      '- Press **Competition** under the map. It cannot be switched during a run; **R** starts the run again.',
      '- **T** takes you to the start, behind the start banner.',
      '- **K** shows the control descriptions, with the next control highlighted.',
      'The clock starts when you leave the start triangle, so plan the first leg while you stand in it.',
      'Run time is game time: the time factor (**E** / **Q**) makes the game go faster, not your time better.',
    ].join('\n'),
    nb: [
      '- Velg kart og løype på startsida (**Åpne løypefil …**), eller legg en løype selv på kartet (**Legg løype**).',
      '- Trykk **Konkurranse** under kartet. Det kan ikke endres under løpet; **R** starter løpet på nytt.',
      '- **T** tar deg til start, bak startbanneret.',
      '- **K** viser postbeskrivelsen, med neste post markert.',
      'Klokka starter når du går ut av starttrekanten, så planlegg første strekk mens du står i den.',
      'Løpstida er spilltid: tidsfaktoren (**E** / **Q**) får spillet til å gå fortere, ikke tida di til å bli bedre.',
    ].join('\n'),
  },
  tutorialSteeringTitle: { en: 'Steering with the map open', nb: 'Styre med kartet oppe' },
  tutorialSteering: {
    en: [
      'Open the map with **M**. It frees the mouse; click the terrain to steer with the mouse again while the map stays open. **Esc** gives the mouse back to the map.',
      'While you steer, the mouse can hold the map instead of turning your view:',
      '- Hold the **left button** and move the mouse to move the map.',
      '- Hold the **right button** to move the thumb.',
      '- Turn the **wheel** to turn the map, 5° a notch, around the thumb.',
      'Your direction stays as it was while you hold a button, and **W A S D** keep you running. Let go to look around and steer again.',
    ].join('\n'),
    nb: [
      'Åpne kartet med **M**. Da blir musa fri; klikk i terrenget for å styre med musa igjen mens kartet er oppe. **Esc** gir musa tilbake til kartet.',
      'Mens du styrer, kan musa holde kartet i stedet for å snu blikket:',
      '- Hold **venstre knapp** og flytt musa for å flytte kartet.',
      '- Hold **høyre knapp** for å flytte tommelen.',
      '- Rull med **hjulet** for å vri kartet, 5° per hakk, rundt tommelen.',
      'Retningen din står fast mens du holder en knapp, og **W A S D** holder deg i gang. Slipp for å se deg rundt og styre igjen.',
    ].join('\n'),
  },
  tutorialSettingTitle: { en: 'Setting the map', nb: 'Orientere kartet' },
  tutorialSetting: {
    en: [
      'A set map lies the same way as the terrain: what is ahead of you is up on the map.',
      "The compass in the map's corner is held as you look: the red needle points north in the terrain, and the dial with its N turns with the map.",
      "- Turn the map with the wheel until the dial's N and the north lines on the map lie along the needle.",
      '- Set the map again each time you change direction. A map that is not set is the most common way to get lost.',
      'The needle swings as you run, more the faster you go. For a careful reading, slow down or stop for a moment.',
    ].join('\n'),
    nb: [
      'Et orientert kart ligger samme vei som terrenget: det som er foran deg, er opp på kartet.',
      'Kompasset i hjørnet av kartet holdes slik du ser: den røde nåla peker mot nord i terrenget, og skiva med N vris med kartet.',
      '- Vri kartet med hjulet til N på skiva og nordlinjene på kartet ligger langs nåla.',
      '- Orienter kartet på nytt hver gang du skifter retning. Et kart som ikke er orientert, er den vanligste måten å gå seg bort på.',
      'Nåla svinger når du løper, mer jo fortere du går. Vil du lese nøyaktig, sakk farten eller stopp et øyeblikk.',
    ].join('\n'),
  },
  tutorialThumbTitle: { en: 'The thumb', nb: 'Tommelen' },
  tutorialThumb: {
    en: [
      'The blue arrow is your thumb: it marks where you think you are. The game never moves it to where you really are.',
      '- It is put on the start when you start, and on each control as you punch it.',
      '- Move it along as you pass features: a path crossing, a stream, a hill. Hold the right button and move the mouse.',
      '- The map turns around the thumb, so the part you are reading stays in place.',
      '- With the mouse free on the map, a click puts the thumb where you click.',
      'Keep the thumb up to date, and you always know where to read on the map.',
    ].join('\n'),
    nb: [
      'Den blå pila er tommelen din: den viser hvor du tror du er. Spillet flytter den aldri dit du faktisk er.',
      '- Den settes på start når du starter, og på hver post når du stempler.',
      '- Flytt den med deg når du passerer noe: et stikryss, en bekk, en haug. Hold høyre knapp og flytt musa.',
      '- Kartet vris rundt tommelen, så det du leser, blir liggende der det er.',
      '- Når musa er fri på kartet, setter et klikk tommelen der du klikker.',
      'Hold tommelen oppdatert, så vet du alltid hvor du skal lese på kartet.',
    ].join('\n'),
  },
  tutorialLegTitle: { en: 'Running a leg', nb: 'Løpe et strekk' },
  tutorialLeg: {
    en: [
      'A straight compass bearing is seldom the fastest way, and it is easy to drift off it. Plan each leg instead:',
      '- **Route choice:** paths and roads are faster than forest; going round a hill, a marsh or a thicket often pays.',
      '- **Handrails:** follow long features such as paths, streams, fences and field edges.',
      '- **Attack point:** run fast to a big, easy feature near the control, then go carefully the last bit.',
      '- **Catching feature:** know what tells you that you have gone too far, such as a path or a lake beyond the control.',
      '- **Aiming off:** aim to one side of a control on a line feature, so you know which way to turn when you reach the line.',
      'After each punch the map glides to the next leg.',
    ].join('\n'),
    nb: [
      'Rett på kompasskurs er sjelden raskest, og det er lett å drive av kursen. Planlegg heller hvert strekk:',
      '- **Veivalg:** stier og veier er raskere enn skog; rundt en haug, en myr eller et tett felt lønner seg ofte.',
      '- **Ledelinjer:** følg lange detaljer som stier, bekker, gjerder og jordekanter.',
      '- **Angrepspunkt:** løp fort til en stor, lett detalj nær posten, og ta det forsiktig det siste stykket.',
      '- **Oppfanger:** vit hva som sier at du har løpt for langt, som en sti eller et vann bak posten.',
      '- **Sikte til siden:** sikt bevisst til én side av en post på en linje, så vet du hvilken vei du skal når du kommer til linja.',
      'Etter hver stempling glir kartet videre til neste strekk.',
    ].join('\n'),
  },
  tutorialControlTitle: { en: 'At the control', nb: 'På posten' },
  tutorialControl: {
    en: [
      '- Read the description (**K**): it says what the feature is and on which side of it the flag stands.',
      '- Check the code: all the controls in the course file stand in the terrain, not only yours. The code is on plates on both sides of the stand.',
      '- You punch when you are within 2.5 m of the flag, and you hear a beep.',
      '- Controls are punched in order: the next one does not count until you have this one.',
    ].join('\n'),
    nb: [
      '- Les beskrivelsen (**K**): den sier hva detaljen er, og på hvilken side av den flagget står.',
      '- Sjekk kodene: alle postene i løypefila står i terrenget, ikke bare dine. Koden står på skilt på begge sider av stativet.',
      '- Du stempler når du er innenfor 2,5 m fra flagget, og du hører et pip.',
      '- Postene stemples i rekkefølge: den neste teller ikke før du har tatt denne.',
    ].join('\n'),
  },
  tutorialFinishTitle: { en: 'At the finish', nb: 'I mål' },
  tutorialFinish: {
    en: [
      '- Write your name and save the result.',
      '- The results list shows leg and split times with their places, as on WinSplits. Sort by run time, or by a leg from its column header.',
      '- Tick a result to see its route on the map, and compare routes: where did you lose time?',
      '- **Results** on the start screen opens the list later.',
      'Good luck!',
    ].join('\n'),
    nb: [
      '- Skriv navnet ditt og lagre resultatet.',
      '- Resultatlista viser strekktider og mellomtider med plassering, som på WinSplits. Sorter etter løpstid, eller etter et strekk fra kolonneoverskriften.',
      '- Kryss av for et resultat for å se veivalget på kartet, og sammenlign veivalg: hvor tapte du tid?',
      '- **Resultater** på startsida åpner lista senere.',
      'Lykke til!',
    ].join('\n'),
  },

  // Results.
  finishTitle: { en: 'Finished {time}', nb: 'I mål {time}' },
  yourName: { en: 'Your name', nb: 'Navnet ditt' },
  nameMissing: { en: 'Write a name', nb: 'Skriv et navn' },
  saveResult: { en: 'Save result', nb: 'Lagre resultatet' },
  dontSave: { en: "Don't save", nb: 'Ikke lagre' },
  saveFailed: { en: 'Could not save: {message}', nb: 'Kunne ikke lagre: {message}' },
  notSaved: {
    en: 'Not saved: competition mode was off. Turn it on under the map before the start to get on the results list.',
    nb: 'Ikke lagret: konkurransemodus var av. Slå den på under kartet før start for å komme på resultatlista.',
  },
  showResults: { en: 'Show results', nb: 'Vis resultater' },
  close: { en: 'Close', nb: 'Lukk' },
  results: { en: 'Results', nb: 'Resultater' },
  resultsButton: { en: 'Results', nb: 'Resultater' },
  resultsButtonTitle: { en: 'The results list of the chosen course', nb: 'Resultatlista for løypa du har valgt' },
  resultsFailed: { en: 'Could not read the results list: {message}', nb: 'Kunne ikke lese resultatlista: {message}' },
  noResults: { en: 'No results yet', nb: 'Ingen resultater ennå' },
  allRuns: { en: 'Show all runs', nb: 'Vis alle løp' },
  handSetCourseOne: {
    en: 'Course set by hand · 1 control · {length} km',
    nb: 'Løype lagt for hånd · 1 post · {length} km',
  },
  handSetCourse: {
    en: 'Course set by hand · {controls} controls · {length} km',
    nb: 'Løype lagt for hånd · {controls} poster · {length} km',
  },
  nameHeader: { en: 'Name', nb: 'Navn' },
  notOnList: { en: 'Your run (not saved)', nb: 'Ditt løp (ikke lagret)' },
  showRoute: { en: 'Show the route on the map', nb: 'Vis veivalget på kartet' },
  sortHint: { en: 'Click: sort by leg time · again: by split time', nb: 'Klikk: sorter etter strekktid · igjen: etter mellomtid' },
  deleteResult: { en: 'Delete this result', nb: 'Slett dette resultatet' },
  confirmDelete: { en: "Delete {name}'s {time}?", nb: 'Slette {time} for {name}?' },

  // Running a course.
  atStart: { en: 'At the start – run when ready', nb: 'På start – løp når du er klar' },
  goToStart: { en: 'Go to the start △ (T: jump there)', nb: 'Gå til start △ (T: hopp dit)' },
  finish: { en: 'Finish', nb: 'Mål' },
  finishShort: { en: 'F', nb: 'M' },
  controlNumber: { en: 'Control {number}', nb: 'Post {number}' },
  finished: { en: 'Finished {time}  (R: run again)', nb: 'I mål {time}  (R: løp igjen)' },
  running: { en: '{time}  ·  next: {label}', nb: '{time}  ·  neste: {label}' },
  bannerStart: { en: 'START', nb: 'START' },
  bannerFinish: { en: 'FINISH', nb: 'MÅL' },
} satisfies Record<string, Record<Lang, string>>

export type TextKey = keyof typeof STRINGS

const STORAGE_KEY = 'terraino.lang'
const LOCALES: Record<Lang, string> = { en: 'en-GB', nb: 'nb-NO' }

/** Move a value stored under the program's old name (otest) to its new key, once. */
export function renameStoredKey(old: string, key: string) {
  try {
    const value = localStorage.getItem(old)
    if (value === null) return
    if (localStorage.getItem(key) === null) localStorage.setItem(key, value)
    localStorage.removeItem(old)
  } catch {
    // Storage can be unavailable (private mode).
  }
}

renameStoredKey('otest.lang', STORAGE_KEY)

function isLang(value: string | null | undefined): value is Lang {
  return value != null && Object.hasOwn(LANGS, value)
}

/** The language from the URL (?lang=), the last choice, or the browser; English otherwise. */
function detectLang(): Lang {
  const fromUrl = new URLSearchParams(location.search).get('lang')
  if (isLang(fromUrl)) return fromUrl
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (isLang(stored)) return stored
  } catch {
    // Storage can be unavailable (private mode).
  }
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag.toLowerCase().split('-')[0]
    if (base === 'nb' || base === 'nn' || base === 'no') return 'nb'
    if (isLang(base)) return base
  }
  return 'en'
}

let current: Lang = detectLang()

export function lang(): Lang {
  return current
}

/** Remember a language and reload the page in it, keeping the other URL parameters. */
export function switchLang(next: Lang) {
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Not remembered, but the URL carries it.
  }
  current = next
  const params = new URLSearchParams(location.search)
  params.set('lang', next)
  location.search = params.toString()
}

/** The text for `key` in the current language, with {placeholders} filled in. */
export function t(key: TextKey, params: Record<string, string | number> = {}): string {
  return STRINGS[key][current].replace(/\{(\w+)\}/g, (all, name: string) =>
    name in params ? String(params[name]) : all,
  )
}

/** A number in the current language's format, for example 4,0 in Norwegian. */
export function formatNumber(value: number, decimals = 0): string {
  return value.toLocaleString(LOCALES[current], {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

/**
 * Fill in elements marked with data-i18n (text) and data-i18n-title (tooltip).
 * Unknown keys are left as they are in the HTML.
 */
export function applyTranslations(root: ParentNode = document) {
  document.documentElement.lang = current
  document.title = `Terrain-O – ${t('tagline')}`
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = el.dataset.i18n
    if (key && key in STRINGS) el.textContent = t(key as TextKey)
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    const key = el.dataset.i18nTitle
    if (key && key in STRINGS) el.title = t(key as TextKey)
  }
}

/** Fill a <select> with the languages and switch when another is chosen. */
/** A flag button for each language in `group`; the current one is pressed. */
export function setupLanguageFlags(group: HTMLElement) {
  for (const [code, name] of Object.entries(LANGS) as [Lang, string][]) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'lang-flag'
    button.title = name
    button.lang = code
    button.setAttribute('aria-label', name)
    button.setAttribute('aria-pressed', String(code === current))
    button.innerHTML = FLAGS[code]
    button.addEventListener('click', () => {
      if (code !== current) switchLang(code)
    })
    group.appendChild(button)
  }
}

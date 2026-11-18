// Сборка аддона: склеивает src/* в dist/script.js, копирует метаданные и стили.
// node build.js            — собрать в dist/
// node build.js --install  — собрать и установить в PulseSync (%APPDATA%\PulseSync\addons\crossfade-dj)
// node build.js --release  — собрать релиз для каталога PulseSync: release/crossfade-dj/ и release/crossfade-dj-<версия>.zip
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = __dirname;
const dist = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'metadata.json'), 'utf8'));
const part = (f) => fs.readFileSync(path.join(root, 'src', f), 'utf8').replace(/^if \(typeof module.*$/m, '');

// Версия в коде и в metadata.json должна совпадать
const codeVersion = (fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8').match(/const VERSION = '([^']+)'/) || [])[1];
if (codeVersion !== pkg.version) {
    console.error(`Версии не совпадают: src/main.js — ${codeVersion}, metadata.json — ${pkg.version}`);
    process.exit(1);
}

const author = Array.isArray(pkg.author) ? pkg.author.join(', ') : pkg.author;
const bundle = `/* ${pkg.name} ${pkg.version} — ${author}. Лицензия MIT. Собрано ${new Date().toISOString().slice(0, 10)} */
(function () {
${part('analysis.js')}
${part('planner.js')}
${part('effects.js')}
${part('main.js')}
})();
`;
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'script.js'), bundle);
fs.copyFileSync(path.join(root, 'metadata.json'), path.join(dist, 'metadata.json'));
fs.copyFileSync(path.join(root, 'styles.css'), path.join(dist, 'styles.css'));
console.log(`dist/script.js: ${(bundle.length / 1024).toFixed(1)} KB, версия ${pkg.version}`);

if (process.argv.includes('--install')) {
    const target = path.join(process.env.APPDATA, 'PulseSync', 'addons', pkg.id);
    fs.mkdirSync(target, { recursive: true });
    for (const f of ['script.js', 'styles.css']) fs.copyFileSync(path.join(dist, f), path.join(target, f));
    // Своя локальная копия помечается как установленная вручную (как делает сам PulseSync)
    fs.writeFileSync(path.join(target, 'metadata.json'), JSON.stringify(Object.assign({}, pkg, { installSource: 'local' }), null, 4) + '\n');
    for (const [src, dst] of [['assets/image.png', pkg.image], ['assets/banner.png', pkg.banner], ['assets/preview.png', pkg.preview], ['README.md', 'README.md']]) {
        if (dst && fs.existsSync(path.join(root, src))) fs.copyFileSync(path.join(root, src), path.join(target, dst));
    }
    console.log(`установлено в ${target}`);
}

if (process.argv.includes('--release')) {
    // Файлы, которые нужны каталогу PulseSync (как у других аддонов): код, метаданные, README, картинки
    const files = [
        ['dist/script.js', 'script.js'], ['dist/metadata.json', 'metadata.json'], ['dist/styles.css', 'styles.css'],
        ['README.md', 'README.md'], ['LICENSE', 'LICENSE'],
        ['assets/image.png', pkg.image], ['assets/banner.png', pkg.banner], ['assets/preview.png', pkg.preview],
    ];
    const missing = files.filter(([src]) => !fs.existsSync(path.join(root, src))).map(([src]) => src);
    if (missing.length) { console.error('Нет файлов для релиза: ' + missing.join(', ')); process.exit(1); }
    const relRoot = path.join(root, 'release');
    const relDir = path.join(relRoot, pkg.id);
    fs.rmSync(relDir, { recursive: true, force: true });
    fs.mkdirSync(relDir, { recursive: true });
    for (const [src, dst] of files) fs.copyFileSync(path.join(root, src), path.join(relDir, dst));
    const zip = path.join(relRoot, `${pkg.id}-${pkg.version}.zip`);
    fs.rmSync(zip, { force: true });
    // В архиве — папка аддона целиком: её распаковывают в %APPDATA%\PulseSync\addons
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${relDir}' -DestinationPath '${zip}' -Force`], { stdio: 'inherit' });
    console.log(`релиз: ${path.relative(root, relDir)}\\ и ${path.relative(root, zip)} (${(fs.statSync(zip).size / 1024).toFixed(0)} KB)`);
}

import fs from 'fs';
async function testFetch() {
    try {
        const settings = JSON.parse(fs.readFileSync('./settings.json', 'utf8'));
        let aiouri = settings.aiostreamsUrl + "/stream/movie/tt0497116.json";
        const metaRes = await fetch(aiouri);
        const meta = await metaRes.json();
        console.dir(meta.streams[0], {depth: null});
    } catch(err) {
        console.error(err);
    }
}
testFetch();

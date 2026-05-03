import fs from 'fs';
async function run() {
  const settings = JSON.parse(fs.readFileSync('./settings.json', 'utf8'));
  let aiouri = settings.aiostreamsUrl + "/stream/movie/tt0497116.json";
  console.log("Fetching streams from AIOStreams...", aiouri);
  const metaRes = await fetch(aiouri);
  const meta = await metaRes.json();
  const validStream = meta.streams.find(s => s.url && s.url.includes('/playback/'));
  if (!validStream) {
      console.log(meta.streams[0]);
      return console.log("No valid stream");
  }
  console.log("Got stream proxy link:", validStream.url);
  
  console.log("Unrolling link...");
  const probeRes = await fetch(validStream.url, {
     method: 'GET',
     redirect: 'manual',
     headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': '*/*'
     }
  });
  console.log("Status:", probeRes.status);
  console.log("Location:", probeRes.headers.get("location"));
  console.log("Body:", await probeRes.text());
}
run();

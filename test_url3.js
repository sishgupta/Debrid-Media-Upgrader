import fetch from 'node-fetch';
import fs from 'fs';

async function testFetch() {
    try {
        // Find DB file
        const db = JSON.parse(fs.readFileSync('./media_library.json', 'utf8'));
        const settings = JSON.parse(fs.readFileSync('./settings.json', 'utf8'));
        
        let aiouri = settings.aiostreamsUrl + "/stream/movie/tt0497116.json";
        const metaRes = await fetch(aiouri);
        const metaText = await metaRes.text();
        const streams = JSON.parse(metaText).streams;
        
        let murl = "";
        for (const s of streams) {
            if (s.url) {
                murl = s.url;
                break;
            }
        }
        
        if (!murl) {
            console.log("No stream URL found in AIOStreams response.");
            return;
        }

        console.log("Found URL:", murl);
        
        // request WITHOUT range 
        console.log("------------------------");
        console.log("Request WITHOUT Range header")
        let res = await fetch(murl, {
             headers: {
                 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                 'Accept': '*/*'
             },
             redirect: 'manual'
        });
        console.log("Status:", res.status);
        if(res.status >= 300 && res.status < 400){
            console.log("Location:", res.headers.get("location"));
        } else {
            console.log("Body:", await res.text());
        }

        // request WITH range
        console.log("------------------------");
        console.log("Request WITH Range header")
        res = await fetch(murl, {
             headers: {
                 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                 'Accept': '*/*',
                 'Range': 'bytes=100-'
             },
             redirect: 'manual'
        });
        console.log("Status:", res.status);
        if(res.status >= 300 && res.status < 400){
            console.log("Location:", res.headers.get("location"));
        } else {
            console.log("Body:", await res.text());
        }
        
    } catch(err) {
        console.error(err);
    }
}
testFetch();

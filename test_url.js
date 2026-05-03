import fetch from 'node-fetch'; // if available, or just global fetch

const url = "https://aiostreamsfortheweebs.midnightignite.me/api/v1/debrid/playback/eyJpIjoiRG1EUWFNNUpHRG9EYXlIVkQ2K2p5Zz09IiwiZSI6IjR3ZkJPd2pMYXVTZ1dVckRRaHJNdkFaOVowVlgrSUpTa2J0MWxNbkYzOVNwVElOWExNNWUxZkE5V05mTHJheTFxMTFCYlJhQzluWVJYM3luSXhadlBCbm5yYVk5TUtDdjR5MTdTbW5mOXRnPSIsInQiOiJhIn0/eyJ0eXBlIjoidG9ycmVudCIsInRpdGxlIjoiQW4uSW5jb252ZW5pZW50LlRydXRoLjIwMDYuMTA4MHAuQU1aTi5XRUJSaXAuRERQNS4xLngyNjQtUU9RIiwiaGFzaCI6ImVkZWNlZmY4NzRjY2ViZTU5Mjg0YTk4NGIwNTg1YzBhZWEwOWVlZWIiLCJzb3VyY2VzIjpbXSwiaW5kZXgiOi0xLCJjYWNoZUFuZFBsYXkiOmZhbHNlLCJhdXRvUmVtb3ZlRG93bmxvYWRzIjpmYWxzZX0/f6c8ef12526ee6022fe4dbd398599cb027fa28f77cd56a127bab8dda33351d89/An.Inconvenient.Truth.2006.1080p.AMZN.WEBRip.DDP5.1.x264-QOQ";

async function testUrl() {
    try {
        const res = await fetch(url, { redirect: 'manual' });
        console.log("Status:", res.status);
        if (res.status >= 300 && res.status < 400) {
            console.log("Redirect header:", res.headers.get("location"));
        } else {
            console.log("Body:", await res.text());
        }
    } catch(e) {
        console.error(e);
    }
}
testUrl();

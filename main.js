const fs      = require('fs');
const cron    = require('node-cron');
const http    = require('http');
const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const discord = require('discord.js');

/* ----- Initialize ----- */
const client = new discord.Client();

client.on('ready', _ => {
    console.log('Bot is ready!');
});

if (process.env.DISCORD_BOT_TOKEN == undefined) {
    console.log("Please set ENV the DISCORD_BOT_TOKEN");
    process.exit(0);
}

client.login(process.env.DISCORD_BOT_TOKEN);

/* ----- Main process ----- */
const urlPrefix          = 'https://w.atwiki.jp/touhoukashi';
const pagelistUrl        = urlPrefix + '/list';
const updatedPages       = {};                                // 更新ページ格納用
let   latestPagename     = '';                                // 最終更新ページ
let   latestModifiedTime = 0;                                 // 最終更新ページの時刻 (from Date.getTime())
let   isLatest           = false;                             // 前回の最終更新情報に到達したか否か
let   data;                                                   // 前回の更新情報

const contributorPattern = /(?<=編集者\s*:\s+).+(?=\s+[\]|])/;

const scrapingDelay = 1000; // スクレイピングの間隔（ミリ秒）
let   lastScraped;          // 最後のスクレイピング時間（ミリ秒）

// 10分おきに更新ページ取得を実行
// cron.schedule('*/10 * * * *', getUpdatedPage);
getUpdatedPage().then(res => console.log(updatedPages));

/**
 * ウィキの更新情報を取得
 */
function getUpdatedPage() {
    return new Promise((resolve, _) => {
        console.log('更新ページ一覧を取得中…');

        fetch(pagelistUrl)
            .then(res => res.text())
            .then(async body => {
                const $                = cheerio.load(body);
                const $pagelistEntries = $('table.pagelist').find('tr');
                      data             = JSON.parse(fs.readFileSync('./data.json', 'utf-8'));
                      lastScraped      = new Date().getTime();

                console.log('更新ページ一覧取得完了');

                for (let i = 1; i < $pagelistEntries.length; i++) {
                    // デバッグ用
                    if (i > 10) break;

                    // 最終更新情報に到達してれば終了
                    if (isLatest) {
                        console.log('yay');
                        break;
                    }

                    const $link    = $pagelistEntries.eq(i).find('a');
                    const pagename = $link.text().trim();
                    const pageid   = $link.attr('href').match(/\d+/);

                    // ページIDが取得できなければ飛ばす
                    if (pageid.length === -1) continue;

                    console.log(`ページ「${pagename}」の編集履歴を取得中…`);

                    // ページの更新情報を取得
                    await getUpdateInfo(pageid[0], pagename);

                    console.log(`ページ「${pagename}」の編集履歴取得完了`);
                }

                console.log('更新ページ一覧取得完了');
                resolve();
            });
    });

}

/**
 * 指定したIDのページの編集履歴を解析し、
 * @param {int} pageid 取得先のページのID
 * @param {string} pagename 取得先のページの名前
 */
function getUpdateInfo(pageid, pagename) {
    return new Promise(async (resolve, _) => {
        const url = `${urlPrefix}/backupx/${pageid}/list.html`;

        // スクレイピング間隔分待機
        while (true) {
            if (lastScraped + scrapingDelay < new Date().getTime()) break;

            // CPU負荷軽減のため時間経過チェック間隔を抑制
            await new Promise(_resolve => {
                setTimeout(() => _resolve(), 250);
            });
        }

        fetch(url)
            .then(res => res.text())
            .then(body => {
                const $                = cheerio.load(body);
                const $backupEntries   = $('#wikibody').find('ul').eq(0).find('li');
                let   isLoggedThisPage = false;                                      // 同じページ名の記録があるか否か
                      lastScraped      = new Date().getTime();

                $backupEntries.each((i, elem) => {
                    const modifiedTime = new Date($(elem).text().split('[')[0]).getTime(); // 編集時間
                    const contributor  = $(elem).text().match(contributorPattern);         // 編集者
                    const action       = ($backupEntries.length - 1 === i) ? '作成' : '編集';  // 操作 (作成|編集)

                    if (pagename === '舞音KAGURA') {
                        console.log('modified: ', $(elem).text().split('[')[0]);
                    }

                    // 前回の最終更新情報と一致したら終了
                    if (data['last-modified'].page === pagename &&
                        data['last-modified'].time === modifiedTime) {
                        isLatest = true;
                        console.log('前回取得の編集履歴に到達しました');

                        return false;
                    }

                    // 前回の最終更新時間より古い編集だったら終了
                    if (data['last-modified'].time > modifiedTime) return false;

                    // 同じページ名が記録されていなければ新規記録
                    if (!isLoggedThisPage) {
                        isLoggedThisPage       = true;
                        updatedPages[pagename] = {
                            url    : `${urlPrefix}/${pageid}.html`,
                            entries: [{
                                action     : action,
                                time       : modifiedTime,
                                contributor: contributor[0].trim()
                            }]
                        }

                        return;
                    }

                    // 記録に同じページ名があればそちらに追記する
                    updatedPages[pagename]['entries'].push({
                        action     : action,
                        time       : modifiedTime,
                        contributor: contributor[0].trim()
                    });
                });

                resolve();
            });
    });

}

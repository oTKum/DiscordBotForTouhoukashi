const fs      = require('fs');
const cron    = require('node-cron');
const http    = require('http');
const fetch   = require('node-fetch');
const moment  = require('moment');
const cheerio = require('cheerio');
const discord = require('discord.js');

/* ----- Initialize ----- */
const client = new discord.Client();

client.on('ready', _ => {
    console.log('Bot is ready!');
    main();
});

if (process.env.DISCORD_BOT_TOKEN == undefined) {
    console.log("Please set ENV the DISCORD_BOT_TOKEN");
    process.exit(0);
}

client.login(process.env.DISCORD_BOT_TOKEN);

/* ----- Main process ----- */
const urlPrefix      = `https://w.atwiki.jp/${process.env.WIKI_ID}`;
const pagelistUrl    = urlPrefix + '/list';
let   updatedPages   = {};                                           // 更新ページ格納用
let   latestPagename = '';                                           // 最終更新ページ
let   isLatest       = false;                                        // 前回の最終更新情報に到達したか否か
let   data;                                                          // 前回の更新情報

const contributorPattern = /(?<=編集者\s*:\s+).+(?=\s+[\]|])/;

const scrapingDelay = 1000; // スクレイピングの間隔（ミリ秒）
let   lastScraped;          // 最後のスクレイピング時間（ミリ秒）

// 10分おきに更新ページ取得を実行
// cron.schedule('*/10 * * * *', getUpdatedPage);
// getUpdatedPage().then(res => console.log(updatedPages));

async function main() {
    const channel = client.channels.cache.get(process.env.DISCORD_UPDATE_CHANNEL_ID);

    await getUpdatedPage();
    isLatest = false;

    // 更新ページがあれば通知作成
    if (Object.keys(updatedPages).length === 0) {
        console.log('更新ページなし');
        return;
    }

    const embedFields  = genEmbedFields(updatedPages);
    const sendInterval = 500;

    for (const [i, fields] of embedFields.entries()) {
        const sendOptions = {};
        // 1回目の埋め込みならcontentを指定
        if (i === 0) {
            sendOptions.content = ((Object.keys(updatedPages).length === 1)
                ? 'いくつか' : '') + 'ページが更新されたみたいですよ～！';
        }
        // 2回目以降の送信は間隔を設ける
        else {
            await new Promise(resolve => {
                setTimeout(() => resolve(), sendInterval);
            });
        }

        sendOptions.embed = {
            color: 16750848,
            fields: fields
        }

        channel.send(sendOptions);
    }

    // TODO: 雑談ページの個別通知

    // 一番最後の編集時間を保存
    (function() {
        // たまに取得した更新ページに最終編集ページがないと言われるので警告（調査中）
        if (!updatedPages.hasOwnProperty(latestPagename)) {
            console.warn('変数「updatedPages」に最終更新ページの項目がありません');
            console.warn('次回実行時に同じ通知内容が送信される恐れがあります');
            return;
        }

        const saveData = {
            'last-modified': updatedPages[latestPagename].entries.slice(-1)[0].time
        }

        fs.writeFile('./data.json', JSON.stringify(saveData, null, '\t'), err => {
            if (err) {
                console.error(`Error: ${err}`);
                return;
            }

            console.log('最終編集ページ時間保存完了');
        });
    })();

    // 変数をリセット
    updatedPages   = {};
    latestPagename = '';
    isLatest       = false;
}

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
                let   isFirstFetch     = true;                                                // 更新ページ一覧上のページ履歴の取得が初めてか否か
                      data             = JSON.parse(fs.readFileSync('./data.json', 'utf-8'));
                      lastScraped      = new Date().getTime();

                console.log('更新ページ一覧取得完了');

                for (let i = 1; i < $pagelistEntries.length; i++) {
                    // デバッグ用
                    if (i > 10) break;

                    // 最終更新情報に到達してれば終了
                    if (isLatest) break;

                    const $link    = $pagelistEntries.eq(i).find('a');
                    const pagename = $link.text().trim();
                    const pageid   = $link.attr('href').match(/\d+/);

                    // ページIDが取得できなければ飛ばす
                    if (pageid.length === -1) continue;

                    // 最初に取得したページを最新ページとして記憶
                    if (isFirstFetch) {
                        isFirstFetch   = false;
                        latestPagename = pagename;
                    }

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
 * 指定したIDのページの編集履歴を解析する
 * @param {int} pageid 取得先のページのID
 * @param {string} pagename 取得先のページの名前
 */
function getUpdateInfo(pageid, pagename) {
    return new Promise(async resolve => {
        const url = `${urlPrefix}/backupx/${pageid}/list.html`;

        // スクレイピング間隔分待機
        while (true) {
            if (lastScraped + scrapingDelay < new Date().getTime()) break;

            // CPU負荷軽減のため時間経過チェック間隔を抑制
            await new Promise(_resolve => {
                setTimeout(() => _resolve(), 249);
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

                    // 前回の最終更新情報と一致したら終了
                    if (data['last-modified'] === modifiedTime) {
                        isLatest = true;
                        console.log('前回取得の編集履歴に到達しました');

                        return false;
                    }

                    // 前回の最終更新時間より古い編集だったら終了
                    if (data['last-modified'] > modifiedTime) return false;

                    const entry = {
                        action     : action,
                        time       : modifiedTime,
                        contributor: contributor[0].trim()
                    }

                    // 同じページ名が記録されていなければ新規記録
                    if (!isLoggedThisPage) {
                        isLoggedThisPage       = true;
                        updatedPages[pagename] = {
                            url    : `${urlPrefix}/${pageid}.html`,
                            entries: [entry]
                        }

                        return;
                    }

                    // 記録に同じページ名があればそちらに追記する
                    updatedPages[pagename].entries.push(entry);
                });

                resolve();
            });
    });
}

/**
 * 更新ページ一覧からDiscordへの埋め込みフィールドを生成する
 * @param {object} pages 更新されたページのオブジェクト
 */
function genEmbedFields(pages) {
    const fields      = [[]];
    const fieldLimits = 25;   // フィールドの最大数
    let   curIndex    = 0;    // フィールドラッパーのインデックス

    for (const [page, v] of Object.entries(pages).reverse()) {
        // このループのフィールド追加で埋め込みフィールド上限数を超える場合は新たな埋め込みを作成
        if (fields[curIndex].length + 4 > fieldLimits) {
            fields.push([]);
            curIndex++;
        }

        // 先頭は装飾を入れてページ名表示
        if (fields[curIndex].length === 0) {
            fields[curIndex].push({
                name : '─'.repeat(22),
                value: `**[${page}](${v.url})**`
            });
        }
        // 先頭じゃなければ空白を設ける
        else {
            fields[curIndex].push({
                name : '\u200B',
                value: `**[${page}](${v.url})**`
            });
        }

        // 編集情報フィールドを追加
        for (const entry of v.entries.reverse()) {
            if (fields[curIndex].length + 3 > fieldLimits) {
                fields.push([]);
                curIndex++;
            }

            fields[curIndex].push({
                name  : ':pencil: **操作**',
                value : entry.action,
                inline: true
            }, {
                name  : ':woman_fairy: **編集者**',
                value : entry.contributor,
                inline: true
            }, {
                name  : ':clock4: **日時**',
                value : moment(entry.time).utcOffset(9).format('YYYY/MM/DD HH:mm:ss'),
                inline: true
            });
        }
    }

    return fields;
}

const http    = require('http');
const discord = require('discord.js');

const client = new discord.Client();

client.on('ready', _ => {
    console.log('Bot is ready!');
});

if (process.env.DISCORD_BOT_TOKEN == undefined) {
    console.log("Please set ENV the DISCORD_BOT_TOKEN");
    process.exit(0);
}

client.login(process.env.DISCORD_BOT_TOKEN);

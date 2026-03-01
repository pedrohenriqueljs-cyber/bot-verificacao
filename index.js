"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const express = require("express");
const app = express();

const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActivityType,
  EmbedBuilder,
} = require("discord.js");

const config = require("./config");

/* =========================
   Logs de erro (pra não ficar “silencioso” no Render)
========================= */
process.on("unhandledRejection", (reason) => {
  console.error("❌ unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("❌ uncaughtException:", err);
});

/* =========================
   Validações
========================= */
if (!process.env.DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN não configurado (Render > Environment).");
  process.exit(1);
}
if (!Array.isArray(config.donos) || config.donos.length === 0) {
  console.error("❌ Nenhum dono configurado no config.js (config.donos).");
  process.exit(1);
}

/* =========================
   DB JSON (data.json)
========================= */
const DB_PATH = path.join(__dirname, "data.json");

function defaultDB() {
  return {
    verify: { messageId: null, channelId: null },
    reactionRoles: {}, // guildId -> { messageId, channelId }
    allowedManagers: [], // ids que podem usar setups
  };
}

function loadDB() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      const initial = defaultDB();
      fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2), "utf8");
      return initial;
    }
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(raw);

    if (!parsed.verify) parsed.verify = { messageId: null, channelId: null };
    if (!parsed.reactionRoles) parsed.reactionRoles = {};
    if (!Array.isArray(parsed.allowedManagers)) parsed.allowedManagers = [];
    return parsed;
  } catch (e) {
    console.error("❌ Erro lendo data.json:", e);
    return defaultDB();
  }
}

function saveDB(next) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(next, null, 2), "utf8");
  } catch (e) {
    console.error("❌ Erro salvando data.json:", e);
  }
}

let db = loadDB();

/* =========================
   Discord Client
========================= */
const VERIFY_BUTTON_ID = "verify_free_access";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,

    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,

    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.on("error", (e) => console.error("❌ Discord client error:", e));
client.on("warn", (m) => console.warn("⚠️ Discord client warn:", m));

/* =========================
   Cooldown (10s por usuário)
========================= */
const VERIFY_COOLDOWN_MS = 10_000;
const verifyCooldown = new Map(); // userId -> lastClickTimestamp

function getCooldownRemainingMs(userId) {
  const last = verifyCooldown.get(userId);
  if (!last) return 0;
  const elapsed = Date.now() - last;
  const remaining = VERIFY_COOLDOWN_MS - elapsed;
  return remaining > 0 ? remaining : 0;
}
function markCooldown(userId) {
  verifyCooldown.set(userId, Date.now());
}

/* =========================
   Helpers
========================= */
function parseEmojiConfig(emojiStr) {
  const match = emojiStr.match(/^<a?:\w+:(\d+)>$/);
  if (match) return { type: "custom", id: match[1] };
  return { type: "unicode", name: emojiStr };
}
const memberEmojiCfg = parseEmojiConfig(config.memberEmoji);

function reactionMatchesConfiguredEmoji(reaction) {
  if (memberEmojiCfg.type === "custom") return reaction.emoji?.id === memberEmojiCfg.id;
  return reaction.emoji?.name === memberEmojiCfg.name;
}

async function getStaffLogChannel() {
  try {
    const g = await client.guilds.fetch(config.communityGuildId);
    const ch = await g.channels.fetch(config.staffLogChannelId);
    return ch ?? null;
  } catch {
    return null;
  }
}

async function logStaff(title, description, color = 0x2b2d31) {
  const ch = await getStaffLogChannel();
  if (!ch) return;
  const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp();
  try {
    await ch.send({ embeds: [embed] });
  } catch (e) {
    console.error("❌ Falha ao enviar log staff:", e);
  }
}

async function safeDM(userId, text) {
  try {
    const user = await client.users.fetch(userId);
    await user.send(text);
    return true;
  } catch {
    return false;
  }
}

async function isMemberOfShop(userId) {
  const shopGuild = await client.guilds.fetch(config.shopGuildId);
  try {
    await shopGuild.members.fetch(userId);
    return true;
  } catch {
    return false;
  }
}

async function addRole(guildId, userId, roleId, reason) {
  const guild = await client.guilds.fetch(guildId);
  const member = await guild.members.fetch(userId);
  if (member.roles.cache.has(roleId)) return { changed: false };
  await member.roles.add(roleId, reason);
  return { changed: true };
}

async function removeRole(guildId, userId, roleId, reason) {
  const guild = await client.guilds.fetch(guildId);
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return { changed: false, notInGuild: true };
  if (!member.roles.cache.has(roleId)) return { changed: false };
  await member.roles.remove(roleId, reason);
  return { changed: true };
}

function getMemberRoleIdForGuild(guildId) {
  if (guildId === config.communityGuildId) return config.memberRoleIdCommunity;
  if (guildId === config.shopGuildId) return config.memberRoleIdShop;
  return null;
}

/* =========================
   Permissões do bot
========================= */
function isOwner(userId) {
  return Array.isArray(config.donos) && config.donos.includes(userId);
}

function isAllowedManager(userId) {
  // Dono sempre pode
  if (isOwner(userId)) return true;
  return db.allowedManagers.includes(userId);
}

function extractTargetUserId(message, arg) {
  // 1) mention
  const mention = message.mentions.users.first();
  if (mention) return mention.id;

  // 2) id no arg
  const cleaned = (arg || "").trim();
  if (/^\d{15,25}$/.test(cleaned)) return cleaned;

  return null;
}

/* =========================
   Mensagens
========================= */
function buildVerifyMessage() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(VERIFY_BUTTON_ID).setLabel("✅ Verificar").setStyle(ButtonStyle.Success)
  );

  return {
    content:
      "🔒 **Verificação de Free Access**\n\n" +
      "Clique em **Verificar** para liberar o cargo.\n" +
      "Você só recebe o cargo se também estiver no Discord da **Loja**.",
    components: [row],
  };
}

function buildMemberReactionMessage() {
  const emojiText = config.memberEmoji;
  return {
    content:
      "**SEJA BEM VINDO !**\n\n" +
      "LEIA AS REGRAS PARA NÃO TOMAR UMA PUNIÇÃO\n\n" +
      `REAJA COM ${emojiText} PARA GANHAR SEU CARGO DE MEMBRO`,
  };
}

async function reactWithConfiguredEmoji(message) {
  try {
    await message.react(config.memberEmoji);
  } catch (e) {
    console.error("❌ Não consegui reagir na mensagem:", e);
  }
}

/* =========================
   Ready
========================= */
client.once("ready", async () => {
  console.log(`🤖 Online como ${client.user.tag}`);

  try {
    client.user.setPresence({
      activities: [{ name: config.presenceText, type: ActivityType.Playing }],
      status: "online",
    });
  } catch (e) {
    console.error("⚠️ Erro setPresence:", e);
  }

  await logStaff("✅ Bot online", `Presença: Jogando **${config.presenceText}**`, 0x57f287);
});

/* =========================
   Sair da Loja -> remove Free Access + DM
========================= */
client.on("guildMemberRemove", async (member) => {
  try {
    if (member.guild.id !== config.shopGuildId) return;

    const userId = member.user.id;

    const res = await removeRole(
      config.communityGuildId,
      userId,
      config.freeAccessRoleId,
      "Saiu do servidor da loja"
    );

    if (res.changed) {
      await logStaff(
        "🧹 Cargo removido (saiu da loja)",
        `Usuário <@${userId}> saiu da **Loja** e teve **Free Access** removido no Community.`,
        0xed4245
      );

      await safeDM(
        userId,
        "⚠️ Seu cargo **Free Access** foi removido porque você saiu do Discord da **Loja**.\n" +
          `Entre novamente: ${config.shopInviteUrl}\n` +
          "Depois volte no Community e clique em **Verificar** para liberar de novo."
      );
    }
  } catch (err) {
    console.error("Erro no guildMemberRemove:", err);
  }
});

/* =========================
   Comandos no chat
   - !setup-verificacao (Community)
   - !setup-membro (Community e Loja)
   - !permissao @user|id (SOMENTE DONO)
   - !delpermissao @user|id (SOMENTE DONO)
========================= */
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild || message.author.bot) return;

    const prefix = config.setupPrefix || "!";
    if (!message.content.startsWith(prefix)) return;

    const [rawCmd, ...rest] = message.content.slice(prefix.length).trim().split(/\s+/);
    const cmd = (rawCmd || "").toLowerCase();
    const arg = rest.join(" ").trim();

    // ======== Permissão (só dono) ========
    if (cmd === "permissao") {
      if (!isOwner(message.author.id)) {
        return message.reply("❌ Só o **dono** pode dar permissão.").catch(() => {});
      }

      const targetId = extractTargetUserId(message, arg);
      if (!targetId) {
        return message.reply("Uso: `!permissao @pessoa` ou `!permissao ID`").catch(() => {});
      }
      if (targetId === config.donoId) {
        return message.reply("✅ Dono já tem permissão total.").catch(() => {});
      }
      if (!db.allowedManagers.includes(targetId)) {
        db.allowedManagers.push(targetId);
        saveDB(db);
      }

      await message.reply(`✅ Permissão adicionada para <@${targetId}>.`).catch(() => {});
      await message.delete().catch(() => {});
      return;
    }

    if (cmd === "delpermissao") {
      if (!isOwner(message.author.id)) {
        return message.reply("❌ Só o **dono** pode remover permissão.").catch(() => {});
      }

      const targetId = extractTargetUserId(message, arg);
      if (!targetId) {
        return message.reply("Uso: `!delpermissao @pessoa` ou `!delpermissao ID`").catch(() => {});
      }
      if (targetId === config.donoId) {
        return message.reply("❌ Não dá pra remover permissão do dono.").catch(() => {});
      }

      db.allowedManagers = db.allowedManagers.filter((id) => id !== targetId);
      saveDB(db);

      await message.reply(`🗑️ Permissão removida de <@${targetId}>.`).catch(() => {});
      await message.delete().catch(() => {});
      return;
    }

    // ======== Setup (dono ou permitidos) ========
    if (cmd === "setup-verificacao" || cmd === "setup-membro") {
      if (!isAllowedManager(message.author.id)) {
        return message.reply("❌ Você não tem permissão para mexer no bot.").catch(() => {});
      }
    }

    if (cmd === "setup-verificacao") {
      if (message.guild.id !== config.communityGuildId) return;

      const sent = await message.channel.send(buildVerifyMessage());
      db.verify.messageId = sent.id;
      db.verify.channelId = message.channel.id;
      saveDB(db);

      await logStaff(
        "🛠️ Setup verificação (botão)",
        `Postado por <@${message.author.id}> em <#${message.channel.id}>.\nSalvo no DB: messageId=${sent.id}`,
        0x5865f2
      );

      await message.delete().catch(() => {});
      return;
    }

    if (cmd === "setup-membro") {
      const guildId = message.guild.id;
      if (guildId !== config.communityGuildId && guildId !== config.shopGuildId) return;

      const sent = await message.channel.send(buildMemberReactionMessage());
      await reactWithConfiguredEmoji(sent);

      db.reactionRoles[guildId] = { messageId: sent.id, channelId: message.channel.id };
      saveDB(db);

      // sem log de emoji
      await message.delete().catch(() => {});
      return;
    }
  } catch (err) {
    console.error("Erro no messageCreate:", err);
  }
});

/* =========================
   Botão Verificar (Community)
========================= */
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isButton()) return;
    if (interaction.customId !== VERIFY_BUTTON_ID) return;

    if (interaction.guildId !== config.communityGuildId) {
      return interaction.reply({ content: "⚠️ Esse botão só funciona no Community.", ephemeral: true });
    }

    const userId = interaction.user.id;

    const last = verifyCooldown.get(userId);
    const remaining = last ? VERIFY_COOLDOWN_MS - (Date.now() - last) : 0;
    if (remaining > 0) {
      const sec = Math.ceil(remaining / 1000);
      return interaction.reply({ content: `⏳ Aguarde **${sec}s** e tente novamente.`, ephemeral: true });
    }
    markCooldown(userId);

    await interaction.deferReply({ ephemeral: true });

    const communityGuild = await client.guilds.fetch(config.communityGuildId);
    const communityMember = await communityGuild.members.fetch(userId);

    if (communityMember.roles.cache.has(config.freeAccessRoleId)) {
      return interaction.editReply("✅ Você **já tem** o cargo **Free Access**.");
    }

    const inShop = await isMemberOfShop(userId);

    if (!inShop) {
      await logStaff(
        "❌ Verificação negada",
        `Usuário <@${userId}> tentou verificar, mas **não está** na Loja.`,
        0xed4245
      );

      return interaction.editReply(
        "❌ Você **ainda não está** no Discord da Loja.\n" +
          `Entre aqui: ${config.shopInviteUrl}\n` +
          "Depois volte e clique em **Verificar** novamente."
      );
    }

    const res = await addRole(config.communityGuildId, userId, config.freeAccessRoleId, "Verificado: membro da loja");

    await logStaff(
      "✅ Verificação OK",
      res.changed
        ? `Usuário <@${userId}> recebeu o cargo **Free Access**.`
        : `Usuário <@${userId}> verificou e já tinha **Free Access**.`,
      0x57f287
    );

    return interaction.editReply(res.changed ? "✅ Cargo **Free Access** liberado!" : "✅ Você já tem o cargo **Free Access**.");
  } catch (err) {
    console.error("Erro no interactionCreate:", err);
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply("❌ Erro ao verificar. Fala com um admin.");
    }
  }
});

/* =========================
   Reaction roles (Membro) - 2 servidores com DB
========================= */
async function handleReactionChange({ reaction, user, isAdd }) {
  if (user.bot) return;

  if (reaction.partial) await reaction.fetch();
  const msg = reaction.message;
  if (!msg?.guild) return;

  const guildId = msg.guild.id;
  if (guildId !== config.communityGuildId && guildId !== config.shopGuildId) return;

  const rr = db.reactionRoles?.[guildId];
  if (!rr?.messageId) return;
  if (msg.id !== rr.messageId) return;

  if (!reactionMatchesConfiguredEmoji(reaction)) return;

  const roleId = getMemberRoleIdForGuild(guildId);
  if (!roleId) return;

  try {
    if (isAdd) {
      await addRole(guildId, user.id, roleId, "Reação: cargo Membro");
    } else {
      await removeRole(guildId, user.id, roleId, "Reação removida: cargo Membro");
    }
  } catch (e) {
    console.error("Erro handleReactionChange:", e);
  }
}

client.on("messageReactionAdd", async (reaction, user) => {
  try {
    await handleReactionChange({ reaction, user, isAdd: true });
  } catch (err) {
    console.error("Erro no messageReactionAdd:", err);
  }
});

client.on("messageReactionRemove", async (reaction, user) => {
  try {
    await handleReactionChange({ reaction, user, isAdd: false });
  } catch (err) {
    console.error("Erro no messageReactionRemove:", err);
  }
});

/* =========================
   Express (porta pro Render Free)
========================= */
app.get("/", (req, res) => {
  res.send("Bot Kingz online 🔥");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor web ativo na porta " + PORT);
});

/* =========================
   Login Discord (com log)
========================= */
console.log("DISCORD_TOKEN existe?", !!process.env.DISCORD_TOKEN);

client
  .login(process.env.DISCORD_TOKEN)
  .then(() => console.log("✅ Login OK (token aceito)."))
  .catch((e) => console.error("❌ Login FALHOU:", e));

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e7 });

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const perfisFile = path.join(__dirname, 'perfis.json');
let perfis = {};
if (fs.existsSync(perfisFile)) {
    try { perfis = JSON.parse(fs.readFileSync(perfisFile, 'utf-8')); } catch(e) { perfis = {}; }
}
function salvarPerfis() { try { fs.writeFileSync(perfisFile, JSON.stringify(perfis, null, 2)); } catch(e) {} }

// ===== CONFIG DO SERVIDOR (banner, nome) =====
const configFile = path.join(__dirname, 'config.json');
let configServidor = { banner: null };
if (fs.existsSync(configFile)) {
    try { Object.assign(configServidor, JSON.parse(fs.readFileSync(configFile, 'utf-8'))); } catch(e) {}
}
function salvarConfig() { try { fs.writeFileSync(configFile, JSON.stringify(configServidor, null, 2)); } catch(e) {} }

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 10) + ext);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ok = ['image/jpeg','image/png','image/gif','image/webp','video/mp4','video/webm','video/ogg','video/quicktime'];
        ok.includes(file.mimetype) ? cb(null, true) : cb(new Error('Tipo não permitido'));
    }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

app.post('/upload', upload.single('arquivo'), (req, res) => {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });
    const url = '/uploads/' + req.file.filename;
    const tipo = req.file.mimetype.startsWith('image/') ? 'imagem' : 'video';
    res.json({ url, tipo, tamanho: req.file.size });
});

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) return res.status(400).json({ erro: err.message });
    if (err) return res.status(400).json({ erro: err.message });
    next();
});

const usuariosOnline = {};
const canaisTexto = ['geral', 'bate-papo', 'comandos', 'memes', 'fotos-e-videos', 'jogos', 'duvidas', 'sugestoes'];
const canaisVoz = ['Geral', 'Jogando', 'Música'];
const historicoMensagens = {};
canaisTexto.forEach(c => historicoMensagens[c] = []);
const salasDeVoz = {};
canaisVoz.forEach(c => salasDeVoz[c] = {});

io.on('connection', (socket) => {
    console.log(`🟢 Conectado: ${socket.id}`);
    socket.emit('canais-iniciais', { texto: canaisTexto, voz: canaisVoz });
    socket.emit('config-servidor', configServidor);
    socket.on('entrar', (dadosUsuario) => {
        const nome = dadosUsuario.nome.trim();
        const perfilSalvo = perfis[nome] || {};
        const perfilFinal = {
            nome,
            avatar: perfilSalvo.avatar || dadosUsuario.avatar,
            banner: perfilSalvo.banner || null,
            bio: perfilSalvo.bio || '',
            cor: perfilSalvo.cor || dadosUsuario.cor
        };
        perfis[nome] = perfilFinal;
        salvarPerfis();
        usuariosOnline[socket.id] = { id: socket.id, ...perfilFinal };
        socket.emit('historico', historicoMensagens);
        socket.emit('meu-perfil', perfilFinal);
        io.emit('lista-usuarios', Object.values(usuariosOnline));
        io.emit('usuario-entrou', usuariosOnline[socket.id]);
    });

    socket.on('atualizar-perfil', (novoPerfil) => {
        const usuario = usuariosOnline[socket.id];
        if (!usuario) return;
        if (novoPerfil.nome && novoPerfil.nome !== usuario.nome) {
            const jaExiste = Object.values(usuariosOnline).some(u => u.nome === novoPerfil.nome && u.id !== socket.id);
            if (jaExiste) { socket.emit('erro-perfil', 'Nome já em uso.'); return; }
            delete perfis[usuario.nome];
            usuario.nome = novoPerfil.nome.trim();
        }
        if (novoPerfil.avatar !== undefined) usuario.avatar = novoPerfil.avatar;
        if (novoPerfil.banner !== undefined) usuario.banner = novoPerfil.banner;
        if (novoPerfil.bio !== undefined) usuario.bio = novoPerfil.bio;
        if (novoPerfil.cor !== undefined) usuario.cor = novoPerfil.cor;
        perfis[usuario.nome] = {
            nome: usuario.nome, avatar: usuario.avatar,
            banner: usuario.banner, bio: usuario.bio, cor: usuario.cor
        };
        salvarPerfis();
        socket.emit('meu-perfil', perfis[usuario.nome]);
        io.emit('lista-usuarios', Object.values(usuariosOnline));
        io.emit('perfil-atualizado', usuariosOnline[socket.id]);
    });

	socket.on('atualizar-banner', (dados) => {
    if (!usuariosOnline[socket.id]) return;
    if (dados.banner !== undefined) configServidor.banner = dados.banner;
    salvarConfig();
    io.emit('config-servidor', configServidor);
    console.log(`🖼️ Banner do servidor atualizado por ${usuariosOnline[socket.id].nome}`);
});

    socket.on('criar-canal', ({ tipo, nome }) => {
        const usuario = usuariosOnline[socket.id];
        if (!usuario || !nome || !tipo) return;
        if (tipo === 'texto') {
            const nomeLimpo = nome.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 30);
            if (!nomeLimpo) { socket.emit('erro-canal', 'Nome inválido.'); return; }
            if (canaisTexto.includes(nomeLimpo)) { socket.emit('erro-canal', 'Já existe.'); return; }
            canaisTexto.push(nomeLimpo);
            historicoMensagens[nomeLimpo] = [];
        } else if (tipo === 'voz') {
            const nomeLimpo = nome.trim().replace(/[<>]/g, '').slice(0, 30);
            if (!nomeLimpo) { socket.emit('erro-canal', 'Nome inválido.'); return; }
            if (canaisVoz.includes(nomeLimpo)) { socket.emit('erro-canal', 'Já existe.'); return; }
            canaisVoz.push(nomeLimpo);
            salasDeVoz[nomeLimpo] = {};
        }
        io.emit('canais-atualizados', { texto: canaisTexto, voz: canaisVoz });
    });

    socket.on('deletar-canal', ({ tipo, nome }) => {
        if (!usuariosOnline[socket.id]) return;
        if (tipo === 'texto') {
            const idx = canaisTexto.indexOf(nome);
            if (idx === -1 || canaisTexto.length <= 1) return;
            canaisTexto.splice(idx, 1);
            delete historicoMensagens[nome];
        } else if (tipo === 'voz') {
            const idx = canaisVoz.indexOf(nome);
            if (idx === -1) return;
            if (Object.keys(salasDeVoz[nome]).length > 0) { socket.emit('erro-canal', 'Canal em uso.'); return; }
            canaisVoz.splice(idx, 1);
            delete salasDeVoz[nome];
        }
        io.emit('canais-atualizados', { texto: canaisTexto, voz: canaisVoz });
    });

    socket.on('mensagem', (dados) => {
        const usuario = usuariosOnline[socket.id];
        if (!usuario || !historicoMensagens[dados.canal]) return;
        const msg = {
            id: Date.now() + Math.random(),
            canal: dados.canal,
            autor: usuario.nome,
            avatar: usuario.avatar,
            cor: usuario.cor,
            tipo: dados.tipo || 'texto',
            texto: dados.texto || '',
            arquivoUrl: dados.arquivoUrl || null,
            arquivoNome: dados.arquivoNome || null,
            hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        };
        historicoMensagens[dados.canal].push(msg);
        if (historicoMensagens[dados.canal].length > 200) historicoMensagens[dados.canal].shift();
        io.emit('nova-mensagem', msg);
    });

    socket.on('digitando', (canal) => {
        const u = usuariosOnline[socket.id];
        if (u) socket.broadcast.emit('usuario-digitando', { nome: u.nome, canal });
    });

        // ===== SISTEMA DE PRESENTES =====
    socket.on('enviar-presente', ({ para, gifUrl }) => {
        const remetente = usuariosOnline[socket.id];
        if (!remetente || !para || !gifUrl) return;
        io.to(para).emit('presente-recebido', {
            de: remetente.nome,
            deAvatar: remetente.avatar,
            deCor: remetente.cor,
            gifUrl: gifUrl
        });
        console.log(`🎁 ${remetente.nome} enviou um presente para ${para}`);
    });

    socket.on('entrar-voz', (canalVoz) => {
        const usuario = usuariosOnline[socket.id];
        if (!usuario || !salasDeVoz[canalVoz]) return;
        const usuariosNaSala = Object.keys(salasDeVoz[canalVoz]);
        socket.join(canalVoz);
        salasDeVoz[canalVoz][socket.id] = {
            nome: usuario.nome,
            avatar: usuario.avatar,
            muted: false,
            deafened: false,
            video: null,
            hasScreenAudio: false
        };
        socket.emit('usuarios-na-voz', { canal: canalVoz, usuarios: usuariosNaSala });
        socket.to(canalVoz).emit('usuario-entrou-voz', {
            socketId: socket.id,
            nome: usuario.nome,
            avatar: usuario.avatar
        });
        io.emit('atualizar-canais-voz', salasDeVoz);
    });

    socket.on('sair-voz', () => sairDaSalaDeVoz(socket));

    socket.on('signal', ({ para, sinal }) => {
        io.to(para).emit('signal', { de: socket.id, sinal });
    });

    socket.on('atualizar-status-voz', ({ canal, muted, deafened, video, hasScreenAudio }) => {
        if (salasDeVoz[canal] && salasDeVoz[canal][socket.id]) {
            if (muted !== undefined) salasDeVoz[canal][socket.id].muted = muted;
            if (deafened !== undefined) salasDeVoz[canal][socket.id].deafened = deafened;
            if (video !== undefined) salasDeVoz[canal][socket.id].video = video;
            if (hasScreenAudio !== undefined) salasDeVoz[canal][socket.id].hasScreenAudio = hasScreenAudio;
            io.emit('atualizar-canais-voz', salasDeVoz);
        }
    });

    socket.on('disconnect', () => {
        sairDaSalaDeVoz(socket);
        const u = usuariosOnline[socket.id];
        if (u) {
            delete usuariosOnline[socket.id];
            io.emit('lista-usuarios', Object.values(usuariosOnline));
            io.emit('usuario-saiu', u);
        }
    });
});

function sairDaSalaDeVoz(socket) {
    for (const canal in salasDeVoz) {
        if (salasDeVoz[canal][socket.id]) {
            delete salasDeVoz[canal][socket.id];
            socket.leave(canal);
            socket.to(canal).emit('usuario-saiu-voz', { socketId: socket.id });
            io.emit('atualizar-canais-voz', salasDeVoz);
            return;
        }
    }
}

const PORTA = process.env.PORT || 3000;
server.listen(PORTA, () => {
    console.log(`✅ Servidor rodando em http://localhost:${PORTA}`);
});
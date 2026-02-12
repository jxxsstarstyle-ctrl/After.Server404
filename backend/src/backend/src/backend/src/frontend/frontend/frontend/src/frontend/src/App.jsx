import React, { useEffect, useState, useRef } from 'react';
import io from 'socket.io-client';

const API = import.meta.env.VITE_API || 'http://localhost:4000';

function tokenGet(){ return localStorage.getItem('token'); }
function authFetch(url, opts = {}) {
  const token = tokenGet();
  return fetch(API + url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}), ...(token?{ Authorization: `Bearer ${token}` }:{}) }
  });
}

export default function App(){
  const [page, setPage] = useState('login');
  const [user, setUser] = useState(null);
  const [matches, setMatches] = useState([]);
  const [socket, setSocket] = useState(null);
  const [room, setRoom] = useState(null);
  const [messages, setMessages] = useState([]);
  const msgRef = useRef();

  useEffect(()=>{
    const token = localStorage.getItem('token');
    if (token) {
      authFetch('/me').then(r=>r.json()).then(data=>{
        if (data.user) { setUser(data.user); setPage('matches'); initSocket(token); }
      }).catch(()=>{});
    }
  },[]);

  function initSocket(token){
    const s = io(API, { auth: { token }});
    s.on('connect', ()=>console.log('socket connected'));
    s.on('message', m=> setMessages(prev => [...prev, m]));
    s.on('match_accepted', ({ roomId }) => {
      setRoom(roomId);
      s.emit('join_room', { roomId });
    });
    setSocket(s);
  }

  async function doLogin(e){
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const res = await fetch(API + '/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(f) });
    const data = await res.json();
    if (data.token) {
      localStorage.setItem('token', data.token);
      setUser(data.user);
      initSocket(data.token);
      setPage('matches');
    } else alert(JSON.stringify(data));
  }

  async function doRegister(e){
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const res = await fetch(API + '/auth/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(f) });
    const data = await res.json();
    if (data.token) {
      localStorage.setItem('token', data.token);
      setUser(data.user);
      initSocket(data.token);
      setPage('matches');
    } else alert(JSON.stringify(data));
  }

  async function loadMatches(){
    const r = await authFetch('/match');
    const j = await r.json();
    setMatches(j.matches || []);
  }

  async function requestMatch(targetId){
    if(!socket) return alert('socket não pronto');
    socket.emit('request_match', { targetId });
    alert('pedido de match enviado');
  }

  function sendMessage(){
    const text = msgRef.current.value;
    if (!text || !room) return;
    socket.emit('send_message', { roomId: room, text });
    msgRef.current.value = '';
  }

  if (page === 'login') {
    return <div style={{padding:20}}>
      <h2>After.Server404 — login / register</h2>
      <div style={{display:'flex', gap:20}}>
        <form onSubmit={doLogin}>
          <h3>Login</h3>
          <input name="username" placeholder="username"/><br/>
          <input name="password" placeholder="password" type="password"/><br/>
          <button>Login</button>
        </form>
        <form onSubmit={doRegister}>
          <h3>Register</h3>
          <input name="username" placeholder="username"/><br/>
          <input name="password" placeholder="password" type="password"/><br/>
          <input name="bio" placeholder="bio"/><br/>
          <input name="interests" placeholder="interests (comma separated)"/><br/>
          <button>Register</button>
        </form>
      </div>
    </div>
  }

  if (page === 'matches') {
    return <div style={{padding:20}}>
      <h2>After.Server404 — Matches</h2>
      <button onClick={loadMatches}>Carregar Matches</button>
      <div style={{display:'flex', gap:20}}>
        <div style={{minWidth:300}}>
          <h4>Possíveis matches</h4>
          {matches.map(m => (
            <div key={m.id} style={{border:'1px solid #ddd', padding:8, marginBottom:6}}>
              <b>{m.username}</b>
              <div>{m.bio}</div>
              <div>score: {m.score.toFixed(3)}</div>
              <button onClick={()=>requestMatch(m.id)}>Pedir match</button>
            </div>
          ))}
        </div>
        <div style={{flex:1}}>
          <h4>Chat</h4>
          {room ? <div>
            <div style={{height:300, overflow:'auto', border:'1px solid #ccc', padding:8}}>
              {messages.map(msg => <div key={msg.id}><b>{msg.senderId}</b>: {msg.text}</div>)}
            </div>
            <input ref={msgRef} placeholder="mensagem"/><button onClick={sendMessage}>Enviar</button>
          </div> : <div>Nenhuma sala ativa. Aceite um match para abrir chat.</div>}
        </div>
      </div>
    </div>
  }

  return null;
}

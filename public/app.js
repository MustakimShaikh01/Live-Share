// Client-side app.js
const socket = io();
let pc = null;
let localStream = null;
let remoteStream = null;
let roomCode = null;
let joined = false;
let isMuted = false;

// STUN servers
const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// DOM
const createRoomBtn = document.getElementById('createRoomBtn');
const adminPassword = document.getElementById('adminPassword');
const roomCodeDisplay = document.getElementById('roomCodeDisplay');
const joinCode = document.getElementById('joinCode');
const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const mediaPanel = document.getElementById('mediaPanel');
const startCamBtn = document.getElementById('startCamBtn');
const stopCamBtn = document.getElementById('stopCamBtn');
const shareScreenBtn = document.getElementById('shareScreenBtn');
const toggleAudioBtn = document.getElementById('toggleAudioBtn');
const sendOfferBtn = document.getElementById('sendOfferBtn');
const statusEl = document.getElementById('status');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');

function log(s){ console.log(s); statusEl.innerText = typeof s === 'string' ? s : JSON.stringify(s); }

createRoomBtn.onclick = async () => {
  const pw = adminPassword.value.trim();
  if (!pw) return alert('Enter admin password (see .env.example)');
  const res = await fetch('/create-room', { method: 'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ password: pw }) });
  const j = await res.json();
  if (!j.ok) return alert('Create failed: ' + (j.error||'unknown'));
  roomCode = j.code;
  roomCodeDisplay.innerText = 'Room code: ' + roomCode;
  joinCode.value = roomCode;
  alert('Room created: ' + roomCode + '\\nShare this code with another participant.');
};

joinBtn.onclick = async () => {
  const code = joinCode.value.trim();
  if (!code) return alert('Enter room code');
  roomCode = code;
  socket.emit('join-room', { room: roomCode });
};

leaveBtn.onclick = () => {
  socket.emit('leave-room');
  cleanup();
};

startCamBtn.onclick = async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
    attachLocalStream(s);
  } catch (e) {
    alert('getUserMedia failed: ' + e.message);
  }
};

stopCamBtn.onclick = () => {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    localVideo.srcObject = null;
  }
  stopCamBtn.disabled = true;
  startCamBtn.disabled = false;
};

shareScreenBtn.onclick = async () => {
  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    // If we already have a camera stream, replace video track; otherwise use screen as local stream
    if (localStream) {
      // replace video track in localStream and in peer connection
      const screenTrack = screenStream.getVideoTracks()[0];
      const oldVideoTrack = localStream.getVideoTracks()[0];
      if (oldVideoTrack) {
        localStream.removeTrack(oldVideoTrack);
        localStream.addTrack(screenTrack);
      } else {
        localStream.addTrack(screenTrack);
      }
      // replace sender's track
      const sender = pc && pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(screenTrack);
    } else {
      attachLocalStream(screenStream);
    }

    // when user stops screen sharing, restore camera if available
    screenStream.getVideoTracks()[0].onended = () => {
      log('Screen share ended');
      // optional: you can restart camera or leave as-is
    };
  } catch (e) {
    alert('Screen share failed: ' + e.message);
  }
};

toggleAudioBtn.onclick = () => {
  if (!localStream) return;
  const audioTracks = localStream.getAudioTracks();
  if (audioTracks.length === 0) return;
  isMuted = !isMuted;
  audioTracks.forEach(t => t.enabled = !isMuted);
  toggleAudioBtn.innerText = isMuted ? 'Unmute Outgoing Audio' : 'Mute Outgoing Audio';
};

sendOfferBtn.onclick = async () => {
  if (!pc) await createPeerConnection();
  // Make an offer to remote peer (useful if you joined first and need to start)
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: otherId, data: { type: 'offer', sdp: offer.sdp } });
  log('Offer sent');
};

let otherId = null;

socket.on('connect', () => log('socket connected: ' + socket.id));
socket.on('joined', async ({ you, others }) => {
  log('Joined room as ' + you + ', others: ' + JSON.stringify(others));
  joined = true;
  mediaPanel.style.display = 'block';
  leaveBtn.disabled = false;
  // If there is already someone, store otherId and create RTCPeerConnection as callee (wait for offer)
  if (others && others.length > 0) {
    otherId = others[0];
    log('Other present: ' + otherId + ' — waiting for offer or create one as needed.');
    // We will wait for offer (the other may create), but allow manual offer if needed.
    sendOfferBtn.disabled = false;
  } else {
    log('Waiting for peer to join...');
    sendOfferBtn.disabled = true;
  }
});

socket.on('peer-joined', ({ id }) => {
  log('Peer joined: ' + id);
  otherId = id;
  // When a new peer joins and we already have media, we can initiate the call
  if (localStream) {
    createPeerConnection().then(async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { to: otherId, data: { type: 'offer', sdp: offer.sdp } });
      log('Sent offer to ' + otherId);
    });
  } else {
    // No media yet; prompt user to start camera
    log('Start your camera/mic or screen to begin call.');
  }
  sendOfferBtn.disabled = false;
});

socket.on('peer-left', ({ id }) => {
  log('Peer left: ' + id);
  otherId = null;
  if (remoteVideo) remoteVideo.srcObject = null;
  if (pc) {
    pc.close();
    pc = null;
  }
});

socket.on('error-message', (m) => alert('Server: ' + m));

socket.on('signal', async ({ from, data }) => {
  log('Signal from ' + from + ': ' + JSON.stringify(data && data.type));
  if (!pc) await createPeerConnection();
  if (data.type === 'offer') {
    await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('signal', { to: from, data: { type: 'answer', sdp: answer.sdp } });
    log('Answered offer');
  } else if (data.type === 'answer') {
    await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
    log('Set remote answer');
  } else if (data.type === 'ice') {
    try {
      await pc.addIceCandidate(data.candidate);
      log('Added ICE candidate');
    } catch (e) {
      console.error(e);
    }
  }
});

async function createPeerConnection() {
  pc = new RTCPeerConnection(config);
  remoteStream = new MediaStream();
  remoteVideo.srcObject = remoteStream;

  pc.onicecandidate = (evt) => {
    if (evt.candidate && otherId) {
      socket.emit('signal', { to: otherId, data: { type: 'ice', candidate: evt.candidate } });
    }
  };

  pc.ontrack = (evt) => {
    evt.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
  };

  // add local tracks if present
  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  }

  pc.onconnectionstatechange = () => {
    log('PC state: ' + pc.connectionState);
  };

  return pc;
}

function attachLocalStream(s) {
  // stop existing local tracks
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
  }
  localStream = s;
  localVideo.srcObject = localStream;
  stopCamBtn.disabled = false;
  startCamBtn.disabled = true;
  // if peer connection exists, replace senders or add tracks
  if (pc) {
    const senders = pc.getSenders();
    localStream.getTracks().forEach(track => {
      const sender = senders.find(s => s.track && s.track.kind === track.kind);
      if (sender) sender.replaceTrack(track);
      else pc.addTrack(track, localStream);
    });
  }
}
function cleanup() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (pc) {
    pc.close();
    pc = null;
  }
  mediaPanel.style.display = 'none';
  roomCode = null;
  joined = false;
  roomCodeDisplay.innerText = '';
  joinCode.value = '';
  leaveBtn.disabled = true;
  sendOfferBtn.disabled = true;
}

window.addEventListener('beforeunload', () => {
  if (joined) socket.emit('leave-room');
});
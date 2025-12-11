// Client-side app.js (modified to support Option D: button based switching)
const socket = io();
let pc = null;
let localStream = null;
let remoteStream = null;
let roomCode = null;
let joined = false;
let isMuted = false;
let otherId = null;
let layoutMode = 'normal'; // 'normal' | 'remote-big' | 'local-big'

/* STUN servers */
const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

/* DOM */
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

/* Option D buttons */
const btnRemoteBig = document.getElementById('btnRemoteBig');
const btnLocalBig = document.getElementById('btnLocalBig');
const btnNormalView = document.getElementById('btnNormalView');

function log(s){ console.log(s); statusEl.innerText = typeof s === 'string' ? 'Status: ' + s : 'Status: ' + JSON.stringify(s); }

/* Admin create room */
createRoomBtn.onclick = async () => {
  const pw = adminPassword.value.trim();
  if (!pw) return alert('Enter admin password (see .env.example)');
  const res = await fetch('/create-room', { method: 'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ password: pw }) });
  const j = await res.json();
  if (!j.ok) return alert('Create failed: ' + (j.error||'unknown'));
  roomCode = j.code;
  roomCodeDisplay.innerText = 'Room code: ' + roomCode;
  joinCode.value = roomCode;
  alert('Room created: ' + roomCode + '\nShare this code with another participant.');
};

/* Join room */
joinBtn.onclick = async () => {
  const code = joinCode.value.trim();
  if (!code) return alert('Enter room code');
  roomCode = code;
  socket.emit('join-room', { room: roomCode });
};

/* Leave */
leaveBtn.onclick = () => {
  socket.emit('leave-room');
  cleanup();
};

/* Start camera & mic */
startCamBtn.onclick = async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
    attachLocalStream(s);
  } catch (e) {
    alert('getUserMedia failed: ' + e.message);
  }
};

/* Stop camera */
stopCamBtn.onclick = () => {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    localVideo.srcObject = null;
  }
  stopCamBtn.disabled = true;
  startCamBtn.disabled = false;
};

/* Share screen/app (may include system audio if OS exposes it) */
shareScreenBtn.onclick = async () => {
  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    // If we already have a camera stream, replace video track; otherwise use screen as local stream
    if (localStream) {
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

    // when user stops screen sharing, log
    const vTrack = screenStream.getVideoTracks()[0];
    if (vTrack) vTrack.onended = () => {
      log('Screen share ended');
    };
  } catch (e) {
    alert('Screen share failed: ' + e.message);
  }
};

/* Mute/unmute outgoing audio */
toggleAudioBtn.onclick = () => {
  if (!localStream) return;
  const audioTracks = localStream.getAudioTracks();
  if (audioTracks.length === 0) return;
  isMuted = !isMuted;
  audioTracks.forEach(t => t.enabled = !isMuted);
  toggleAudioBtn.innerText = isMuted ? 'Unmute Outgoing Audio' : 'Mute Outgoing Audio';
};

/* Manual offer */
sendOfferBtn.onclick = async () => {
  if (!pc) await createPeerConnection();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  if (!otherId) return alert('No other peer id available to send offer to.');
  socket.emit('signal', { to: otherId, data: { type: 'offer', sdp: offer.sdp } });
  log('Offer sent');
};

/* Socket event handling */
socket.on('connect', () => log('socket connected: ' + socket.id));

socket.on('joined', async ({ you, others }) => {
  log('Joined room as ' + you + ', others: ' + JSON.stringify(others));
  joined = true;
  mediaPanel.style.display = 'block';
  leaveBtn.disabled = false;
  // If someone present, store otherId
  if (others && others.length > 0) {
    otherId = others[0];
    log('Other present: ' + otherId + ' — waiting for offer or create one as needed.');
    sendOfferBtn.disabled = false;
  } else {
    log('Waiting for peer to join...');
    sendOfferBtn.disabled = true;
  }
});

socket.on('peer-joined', ({ id }) => {
  log('Peer joined: ' + id);
  otherId = id;
  // If we have media, initiate call
  if (localStream) {
    createPeerConnection().then(async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { to: otherId, data: { type: 'offer', sdp: offer.sdp } });
      log('Sent offer to ' + otherId);
    });
  } else {
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
  // Reset layout to normal when peer leaves
  setNormalView();
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

/* Create RTCPeerConnection */
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
    // Attach tracks to remoteStream
    if (evt.streams && evt.streams[0]) {
      evt.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
    } else {
      // fallback
      evt.track && remoteStream.addTrack(evt.track);
    }
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

/* Attach a local stream (camera or screen) */
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
  } else {
    // if a peer is present, initiate connection
    if (otherId) {
      createPeerConnection().then(() => {
        // auto-offer
        createAndSendOfferIfReady();
      });
    }
  }
}

/* Create and send offer if pc exists and otherId set */
async function createAndSendOfferIfReady() {
  if (!pc) return;
  if (!otherId) return;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: otherId, data: { type: 'offer', sdp: offer.sdp } });
  log('Offer created and sent');
}

/* Cleanup */
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
  // reset view to normal
  setNormalView();
}

/* Layout control functions for Option D */
function setRemoteBig() {
  // remove classes first
  clearVideoClasses();
  // apply remote big
  remoteVideo.classList.add('big-video');
  // local as pip
  localVideo.classList.add('pip');
  localVideo.classList.remove('hide'); // ensure visible
  remoteVideo.classList.remove('hide');
  layoutMode = 'remote-big';
  log('Layout: remote big');
}

function setLocalBig() {
  clearVideoClasses();
  localVideo.classList.add('big-video');
  // remote becomes pip (small) or hide remote? we'll make remote small inline
  remoteVideo.classList.add('pip');
  remoteVideo.classList.remove('hide');
  localVideo.classList.remove('hide');
  layoutMode = 'local-big';
  log('Layout: local big');
}

function setNormalView() {
  clearVideoClasses();
  // ensure both visible with default style
  localVideo.classList.remove('hide');
  remoteVideo.classList.remove('hide');
  layoutMode = 'normal';
  log('Layout: normal');
}

/* helper to clear layout classes */
function clearVideoClasses() {
  [localVideo, remoteVideo].forEach(v => {
    v.classList.remove('big-video', 'pip', 'hide');
    // reset width/height to defaults by removing inline styles if any
    v.style.width = '';
    v.style.height = '';
  });
}

/* attach button event listeners for Option D */
btnRemoteBig.onclick = () => setRemoteBig();
btnLocalBig.onclick = () => setLocalBig();
btnNormalView.onclick = () => setNormalView();

/* also allow clicking on videos to toggle respective big mode */
localVideo.addEventListener('click', () => {
  if (layoutMode === 'local-big') setNormalView();
  else setLocalBig();
});
remoteVideo.addEventListener('click', () => {
  if (layoutMode === 'remote-big') setNormalView();
  else setRemoteBig();
});

/* beforeunload to leave room */
window.addEventListener('beforeunload', () => {
  if (joined) socket.emit('leave-room');
});

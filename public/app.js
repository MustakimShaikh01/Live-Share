// public/app.js
// Rewritten robust client with device selection, layout controls, recording and reliability improvements.

const socket = io();
let pc = null;
let localStream = null;
let remoteStream = null;
let roomCode = null;
let joined = false;
let isMuted = false;
let otherId = null;
let recordingBlobs = [];
let mediaRecorder = null;

/* STUN servers (add TURN when needed) */
const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

/* DOM references */
const adminPassword = document.getElementById('adminPassword');
const createRoomBtn = document.getElementById('createRoomBtn');
const roomCodeDisplay = document.getElementById('roomCodeDisplay');
const joinCode = document.getElementById('joinCode');
const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');

const cameraSelect = document.getElementById('cameraSelect');
const micSelect = document.getElementById('micSelect');
const speakerSelect = document.getElementById('speakerSelect');
const startCamBtn = document.getElementById('startCamBtn');
const stopCamBtn = document.getElementById('stopCamBtn');
const shareScreenBtn = document.getElementById('shareScreenBtn');

const btnRemoteBig = document.getElementById('btnRemoteBig');
const btnLocalBig = document.getElementById('btnLocalBig');
const btnNormalView = document.getElementById('btnNormalView');
const btnHideOther = document.getElementById('btnHideOther');
const btnFullscreen = document.getElementById('btnFullscreen');
const toggleMuteBtn = document.getElementById('toggleMuteBtn');

const localScale = document.getElementById('localScale');
const remoteScale = document.getElementById('remoteScale');
const localScaleLabel = document.getElementById('localScaleLabel');
const remoteScaleLabel = document.getElementById('remoteScaleLabel');

const recordBtn = document.getElementById('recordBtn');
const downloadRecordBtn = document.getElementById('downloadRecordBtn');

const statusEl = document.getElementById('status');
const centerPlaceholder = document.getElementById('centerPlaceholder');

const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const localFrame = document.getElementById('localFrame');
const remoteFrame = document.getElementById('remoteFrame');

function setStatus(s){ statusEl.innerText = s; console.log('[status]', s); }

/* --- initialization --- */
async function enumerateDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === 'videoinput');
    const mics = devices.filter(d => d.kind === 'audioinput');
    const speakers = devices.filter(d => d.kind === 'audiooutput');

    cameraSelect.innerHTML = cams.length ? cams.map(c => `<option value="${c.deviceId}">${c.label || 'Camera ' + (cams.indexOf(c)+1)}</option>`).join('') : '<option value="">No camera</option>';
    micSelect.innerHTML = mics.length ? mics.map(m => `<option value="${m.deviceId}">${m.label || 'Mic ' + (mics.indexOf(m)+1)}</option>`).join('') : '<option value="">No mic</option>';
    speakerSelect.innerHTML = speakers.length ? speakers.map(s => `<option value="${s.deviceId}">${s.label || 'Speaker ' + (speakers.indexOf(s)+1)}</option>`).join('') : '<option value="">Default speaker</option>';
  } catch (e) {
    console.warn('enumerateDevices failed', e);
  }
}

// run early
enumerateDevices();

/* --- Room / admin actions --- */
createRoomBtn.onclick = async () => {
  const pw = adminPassword.value.trim();
  if (!pw) return alert('Enter admin password (see .env.example)');
  try {
    const res = await fetch('/create-room', {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ password: pw })
    });
    const j = await res.json();
    if (!j.ok) return alert('Create failed: ' + (j.error || 'unknown'));
    roomCode = j.code;
    roomCodeDisplay.innerText = 'Room code: ' + roomCode;
    joinCode.value = roomCode;
    alert('Room created: ' + roomCode + '\nShare this code with your peer.');
    setStatus('Room created: ' + roomCode);
  } catch (e) {
    alert('Create room failed: ' + e.message);
  }
};

joinBtn.onclick = () => {
  const code = joinCode.value.trim();
  if (!code) return alert('Enter room code');
  roomCode = code;
  socket.emit('join-room', { room: roomCode });
};

leaveBtn.onclick = () => {
  socket.emit('leave-room');
  cleanup();
};

/* --- Media actions: start camera, stop, share screen --- */
startCamBtn.onclick = async () => {
  try {
    const videoId = cameraSelect.value || undefined;
    const micId = micSelect.value || undefined;
    const constraints = {
      audio: micId ? { deviceId: { exact: micId } } : true,
      video: videoId ? { deviceId: { exact: videoId }, width: {ideal:1280}, height:{ideal:720} } : { width:1280, height:720 }
    };
    const s = await navigator.mediaDevices.getUserMedia(constraints);
    attachLocalStream(s);
    setStatus('Camera + mic started');
    // re-enumerate to update labels
    enumerateDevices();
  } catch (e) {
    alert('Could not start camera: ' + e.message);
    console.error(e);
  }
};

stopCamBtn.onclick = () => {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    localVideo.srcObject = null;
    setStatus('Camera stopped');
  }
  stopCamBtn.disabled = true;
  startCamBtn.disabled = false;
};

shareScreenBtn.onclick = async () => {
  try {
    // try to include system audio if the OS exposes it
    const s = await navigator.mediaDevices.getDisplayMedia({ video:true, audio:true });
    attachScreenStream(s);
    setStatus('Screen sharing started');
  } catch (e) {
    alert('Screen share failed: ' + e.message);
    console.error(e);
  }
};

/* attach screen: choose to replace video track but keep mic */
function attachScreenStream(screenStream) {
  if (!screenStream) return;
  const screenVideoTrack = screenStream.getVideoTracks()[0];
  const screenAudioTrack = screenStream.getAudioTracks()[0];

  // if we have localStream, replace its video track
  if (localStream) {
    const senders = pc ? pc.getSenders() : [];
    const oldVideoTrack = localStream.getVideoTracks()[0];
    if (oldVideoTrack) {
      try { localStream.removeTrack(oldVideoTrack); } catch (e) {}
    }
    localStream.addTrack(screenVideoTrack);
    // replace in peer connection
    if (pc) {
      const videoSender = senders.find(s => s.track && s.track.kind === 'video');
      if (videoSender) videoSender.replaceTrack(screenVideoTrack);
      else pc.addTrack(screenVideoTrack, localStream);
    }
    // if screen provides audio and localStream has no audio, add it
    if (screenAudioTrack && localStream.getAudioTracks().length === 0) {
      localStream.addTrack(screenAudioTrack);
      if (pc) pc.addTrack(screenAudioTrack, localStream);
    }
    localVideo.srcObject = localStream;
  } else {
    // no local stream exists - treat screen stream as local
    attachLocalStream(screenStream);
  }

  // when screen sharing stops, remove screen track and try to restore camera if available
  if (screenVideoTrack) {
    screenVideoTrack.onended = () => {
      setStatus('Screen share ended');
      // Attempt to restart camera if previously selected
      // (do NOT auto-start microphone without explicit permission in future)
    };
  }
}

/* Attach local stream (camera or screen as local) */
function attachLocalStream(s) {
  // stop existing local tracks
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  localStream = s;
  localVideo.srcObject = localStream;
  stopCamBtn.disabled = false;
  startCamBtn.disabled = true;

  // If we already have a peer connection, replace or add tracks
  if (pc) {
    const senders = pc.getSenders();
    localStream.getTracks().forEach(track => {
      const sender = senders.find(s => s.track && s.track.kind === track.kind);
      if (sender) {
        try { sender.replaceTrack(track); } catch (e) { console.warn(e); }
      } else {
        pc.addTrack(track, localStream);
      }
    });
  } else {
    // if the other peer is present, create pc and offer
    if (otherId) {
      createPeerConnection().then(() => createAndSendOfferIfReady()).catch(console.error);
    }
  }
}

/* --- Layout controls --- */
function clearVideoClasses() {
  [localVideo, remoteVideo].forEach(v => {
    v.classList.remove('big-video','small','hide');
    // reset transforms / sizes
    v.style.transform = '';
  });
  centerPlaceholder.classList.remove('show');
}

function setRemoteBig() {
  clearVideoClasses();
  remoteVideo.classList.add('big-video');
  localVideo.classList.add('small');
  centerPlaceholder.classList.remove('show');
  setStatus('Remote big');
}

function setLocalBig() {
  clearVideoClasses();
  localVideo.classList.add('big-video');
  remoteVideo.classList.add('small');
  centerPlaceholder.classList.remove('show');
  setStatus('Local big');
}

function setNormalView() {
  clearVideoClasses();
  setStatus('Normal view');
}

function hideOtherCentered() {
  // hide remote and show a placeholder message in center
  clearVideoClasses();
  remoteVideo.classList.add('hide');
  centerPlaceholder.classList.add('show');
  setStatus('Other hidden (center)');
}

function toggleFullscreen() {
  // if any element is fullscreen, exit; else put remoteFrame in fullscreen if remote big, else localFrame
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    // prefer remote if visible
    if (!remoteVideo.classList.contains('hide')) {
      remoteVideo.requestFullscreen?.();
    } else {
      localVideo.requestFullscreen?.();
    }
  }
}

/* attach events to layout buttons */
btnRemoteBig.onclick = setRemoteBig;
btnLocalBig.onclick = setLocalBig;
btnNormalView.onclick = setNormalView;
btnHideOther.onclick = hideOtherCentered;
btnFullscreen.onclick = toggleFullscreen;

/* scale sliders */
localScale.oninput = () => {
  const v = parseFloat(localScale.value);
  localScaleLabel.innerText = Math.round(v*100) + '%';
  localFrame.style.transform = `scale(${v})`;
};
remoteScale.oninput = () => {
  const v = parseFloat(remoteScale.value);
  remoteScaleLabel.innerText = Math.round(v*100) + '%';
  remoteFrame.style.transform = `scale(${v})`;
};

/* Mute toggle */
toggleMuteBtn.onclick = () => {
  if (!localStream) return alert('Start camera first');
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  toggleMuteBtn.innerText = isMuted ? 'Unmute Outgoing' : 'Mute Outgoing';
};

/* Recording */
recordBtn.onclick = () => {
  if (!localStream && !remoteStream) return alert('Start camera or wait for remote stream');
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }
  recordingBlobs = [];
  // prefer recording combined local+remote? here we record localStream only (can extend)
  const toRecord = localStream || remoteStream;
  try {
    mediaRecorder = new MediaRecorder(toRecord, { mimeType: 'video/webm;codecs=vp9,opus' });
  } catch (e) {
    mediaRecorder = new MediaRecorder(toRecord);
  }
  mediaRecorder.ondataavailable = (ev) => { if(ev.data && ev.data.size) recordingBlobs.push(ev.data); };
  mediaRecorder.onstop = () => {
    downloadRecordBtn.disabled = false;
    setStatus('Recording stopped');
  };
  mediaRecorder.start(1000);
  setStatus('Recording started');
};

downloadRecordBtn.onclick = () => {
  const blob = new Blob(recordingBlobs, { type: 'video/webm' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `recording-${Date.now()}.webm`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

/* --- WebRTC Signaling & PC creation --- */

socket.on('connect', () => { setStatus('Connected to signaling'); });

socket.on('joined', ({ you, others }) => {
  setStatus('Joined as ' + you);
  joined = true;
  leaveBtn.disabled = false;
  if (others && others.length > 0) {
    otherId = others[0];
    setStatus('Peer present: ' + otherId);
    // if local stream exists, start call
    if (localStream) {
      createPeerConnection().then(() => createAndSendOfferIfReady()).catch(console.error);
    }
  } else {
    setStatus('Waiting for peer to join...');
  }
});

socket.on('peer-joined', ({ id }) => {
  otherId = id;
  setStatus('Peer joined: ' + id);
  if (localStream) {
    createPeerConnection().then(() => createAndSendOfferIfReady()).catch(console.error);
  }
});

socket.on('peer-left', ({ id }) => {
  setStatus('Peer left: ' + id);
  otherId = null;
  if (remoteVideo) remoteVideo.srcObject = null;
  if (pc) { pc.close(); pc = null; }
  setNormalView();
});

socket.on('error-message', (m) => alert('Server: ' + m));

socket.on('signal', async ({ from, data }) => {
  // incoming signaling from remote
  if (!pc) await createPeerConnection();
  if (data.type === 'offer') {
    await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('signal', { to: from, data: { type: 'answer', sdp: answer.sdp } });
    setStatus('Answered offer');
  } else if (data.type === 'answer') {
    await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
    setStatus('Received answer');
  } else if (data.type === 'ice') {
    try { await pc.addIceCandidate(data.candidate); } catch (e) { console.warn('ICE add failed', e); }
  }
});

/* Utility to create RTCPeerConnection */
async function createPeerConnection() {
  if (pc) return pc;
  pc = new RTCPeerConnection(config);

  remoteStream = new MediaStream();
  remoteVideo.srcObject = remoteStream;

  pc.onicecandidate = (evt) => {
    if (evt.candidate && otherId) {
      socket.emit('signal', { to: otherId, data: { type: 'ice', candidate: evt.candidate } });
    }
  };

  pc.ontrack = (evt) => {
    // prefer stream object if provided
    if (evt.streams && evt.streams[0]) {
      remoteVideo.srcObject = evt.streams[0];
      remoteStream = evt.streams[0];
    } else {
      // fallback add track to remoteStream
      if (!remoteStream) remoteStream = new MediaStream();
      remoteStream.addTrack(evt.track);
      remoteVideo.srcObject = remoteStream;
    }
  };

  pc.onconnectionstatechange = () => {
    setStatus('PC state: ' + pc.connectionState);
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      // keep UI responsive
    }
  };

  // Add local tracks if present
  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  }

  return pc;
}

/* Create offer and send to remote */
async function createAndSendOfferIfReady() {
  if (!pc) await createPeerConnection();
  if (!otherId) return;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: otherId, data: { type: 'offer', sdp: offer.sdp } });
  setStatus('Offer sent');
}

/* Attach local stream into pc or store for later */
function ensureLocalTracksAddedToPc() {
  if (!pc || !localStream) return;
  const senders = pc.getSenders();
  localStream.getTracks().forEach(track => {
    const sender = senders.find(s => s.track && s.track.kind === track.kind);
    if (sender) {
      try { sender.replaceTrack(track); } catch (e) { console.warn(e); }
    } else {
      pc.addTrack(track, localStream);
    }
  });
}

/* Cleanup */
function cleanup() {
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; localVideo.srcObject = null; }
  if (pc) { pc.close(); pc = null; }
  if (remoteVideo) remoteVideo.srcObject = null;
  joined = false; otherId = null; roomCode = null;
  leaveBtn.disabled = true;
  setNormalView();
  setStatus('Left');
}

/* Before unload */
window.addEventListener('beforeunload', () => {
  if (joined) socket.emit('leave-room');
});

/* When devices change update the lists */
navigator.mediaDevices?.addEventListener?.('devicechange', enumerateDevices);

/* allow selecting speaker (some browsers support setSinkId) */
speakerSelect.onchange = () => {
  const id = speakerSelect.value;
  if (typeof remoteVideo.sinkId !== 'undefined' && id) {
    remoteVideo.setSinkId(id).catch(e => console.warn('setSinkId failed', e));
  }
};

/* click on videos to toggle normal/big */
localVideo.addEventListener('click', () => {
  if (localVideo.classList.contains('big-video')) setNormalView(); else setLocalBig();
});
remoteVideo.addEventListener('click', () => {
  if (remoteVideo.classList.contains('big-video')) setNormalView(); else setRemoteBig();
});

/* when user chooses devices in the dropdown, do nothing until startCam clicked.
   but if localStream exists and user changes camera selection we can restart camera */
cameraSelect.onchange = micSelect.onchange = async () => {
  // if currently streaming from camera, restart local stream with chosen devices
  if (localStream) {
    try {
      const cam = cameraSelect.value || undefined;
      const mic = micSelect.value || undefined;
      const s = await navigator.mediaDevices.getUserMedia({
        video: cam ? { deviceId: { exact: cam }, width:{ideal:1280}, height:{ideal:720} } : true,
        audio: mic ? { deviceId: { exact: mic } } : true
      });
      attachLocalStream(s);
      setStatus('Restarted local with new devices');
    } catch (e) {
      console.warn('device restart failed', e);
    }
  }
};

/* initial device enumeration on load */
enumerateDevices();

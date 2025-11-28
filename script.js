/* script.js — CobainTech merged (working base + upgraded chat + call system)
   - Contains: helpers, products, cart, checkout, auth, admin, orders
   - Replaces chat functions with upgraded real-time chat (usernames, unread badges, typing, notifications)
   - Adds a minimal WebRTC call feature (Firestore signaling) for demo/testing
   IMPORTANT: Calls require HTTPS (or localhost) and TURN servers may be needed for production NAT traversal.
*/

/* ---------- Utilities ---------- */
const DOM = {
    q: (sel) => document.querySelector(sel),
    qAll: (sel) => document.querySelectorAll(sel)
};

const Formatter = {
    money: (v) => `₱${Number(v).toLocaleString()}`,
    escapeHtml: (s) => String(s || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    time: (ts) => {
        if (!ts) return '';
        try {
            return ts.toDate ? ts.toDate().toLocaleString() : new Date(ts).toLocaleString();
        } catch (e) {
            return new Date(ts).toLocaleString();
        }
    }
};

const Utils = {
    debounce: (fn, d = 200) => {
        let t;
        return (...a) => {
            clearTimeout(t);
            t = setTimeout(() => fn(...a), d);
        };
    },
    placeholderDataURL: (text) => {
        const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='700'>
            <rect fill='#0b0c0e' width='100%' height='100%'/>
            <text x='50%' y='50%' font-size='48' font-family='Segoe UI, Roboto' fill='#fff' text-anchor='middle' alignment-baseline='middle'>${Formatter.escapeHtml(text)}</text>
        </svg>`;
        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    }
};

/* ---------- Firestore References ---------- */
const Firestore = {
    products: () => db.collection('products'),
    orders: () => db.collection('orders'),
    users: () => db.collection('users'),
    chats: () => db.collection('chats'),
    calls: () => db.collection('calls')
};

/* ---------- Application Initialization ---------- */
window.addEventListener('load', () => {
    setFooterYear();
    bindAuthState();
    initIndex();
    initAdmin();
    initCustomerOrders();
});

/* ---------- WebRTC Call System (Upgraded with Camera Toggle & Features) ---------- */
const CallManager = {
    config: { 
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ] 
    },
    localStream: null,
    remoteStream: null,
    peerConnection: null,
    currentCallId: null,
    isCaller: false,
    ringtoneAudio: null,
    ringtoneInterval: null,
    isVideoEnabled: true,
    isAudioEnabled: true,
    callStartTime: null,
    callTimerInterval: null,
    isScreenSharing: false,
    screenStream: null,

    // Initialize call system
    init() {
        console.log("📞 CallManager initialized");
        this.setupRingtone();
        this.listenForIncomingCalls();
        this.setupCallUIListeners();
    },

    // Setup UI event listeners
    setupCallUIListeners() {
        // These will be attached when call UI is shown
        document.addEventListener('click', (e) => {
            if (e.target.id === 'toggle-video-btn') {
                this.toggleVideo();
            } else if (e.target.id === 'toggle-audio-btn') {
                this.toggleAudio();
            } else if (e.target.id === 'toggle-screen-share-btn') {
                this.toggleScreenShare();
            } else if (e.target.id === 'mute-remote-btn') {
                this.toggleRemoteAudio();
            } else if (e.target.id === 'call-duration') {
                this.toggleTimerDisplay();
            }
        });
    },

    // Setup ringtone audio
    setupRingtone() {
        this.ringtoneAudio = new Audio();
        this.ringtoneAudio.loop = true;
        this.createRingtone();
    },

    // Create a ringtone using Web Audio API
    createRingtone() {
        try {
            // Use a simple beep ringtone
            this.ringtoneAudio.src = "data:audio/wav;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAABAAACcQCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA//////////////////////////////////////////////////////////////////8AAABhTEFNRTMuMTAwBKkAAAAAAAAAADUgJAOBQQAARAAACcQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//sQxAADwAABpAAAAlAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";
        } catch (error) {
            console.log("❌ Ringtone setup failed:", error);
        }
    },

    // Play ringtone
    playRingtone() {
        try {
            if (this.ringtoneAudio) {
                this.ringtoneAudio.currentTime = 0;
                this.ringtoneAudio.play().catch(e => {
                    console.log("❌ Ringtone play failed:", e);
                    this.playFallbackRingtone();
                });
            } else {
                this.playFallbackRingtone();
            }
        } catch (error) {
            console.log("❌ Ringtone error:", error);
            this.playFallbackRingtone();
        }
    },

    // Fallback ringtone using beeps
    playFallbackRingtone() {
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            
            const playBeep = () => {
                const oscillator = audioContext.createOscillator();
                const gainNode = audioContext.createGain();
                
                oscillator.connect(gainNode);
                gainNode.connect(audioContext.destination);
                
                oscillator.type = 'sine';
                oscillator.frequency.value = 800;
                gainNode.gain.value = 0.1;
                
                oscillator.start();
                gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.5);
                oscillator.stop(audioContext.currentTime + 0.5);
            };
            
            this.ringtoneInterval = setInterval(playBeep, 1000);
            
        } catch (error) {
            console.log("❌ Fallback ringtone failed:", error);
        }
    },

    // Stop ringtone
    stopRingtone() {
        try {
            if (this.ringtoneAudio) {
                this.ringtoneAudio.pause();
                this.ringtoneAudio.currentTime = 0;
            }
            
            if (this.ringtoneInterval) {
                clearInterval(this.ringtoneInterval);
                this.ringtoneInterval = null;
            }
        } catch (error) {
            console.log("❌ Stop ringtone error:", error);
        }
    },

    // Media Management
    async prepareLocalMedia(videoEnabled = true, audioEnabled = true) {
        try {
            console.log("🎥 Preparing local media...");
            
            const constraints = {
                audio: audioEnabled ? {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                } : false,
                video: videoEnabled ? {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    frameRate: { ideal: 30 }
                } : false
            };

            this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
            
            const localEl = document.getElementById('local-video');
            if (localEl) {
                localEl.srcObject = this.localStream;
                localEl.muted = true;
                console.log("✅ Local media ready");
            }

            this.isVideoEnabled = videoEnabled;
            this.isAudioEnabled = audioEnabled;

        } catch (err) {
            console.error('❌ Media access failed:', err);
            alert('Unable to access camera/microphone. Please check permissions.');
            throw err;
        }
    },

    // Toggle video on/off
    async toggleVideo() {
        if (!this.localStream) return;

        try {
            const videoTrack = this.localStream.getVideoTracks()[0];
            if (videoTrack) {
                this.isVideoEnabled = !this.isVideoEnabled;
                videoTrack.enabled = this.isVideoEnabled;
                
                // Update UI
                this.updateMediaButtons();
                console.log(`📹 Video ${this.isVideoEnabled ? 'enabled' : 'disabled'}`);
                
                // Send state update to peer
                this.sendMediaStateUpdate();
            }
        } catch (error) {
            console.error('❌ Toggle video failed:', error);
        }
    },

    // Toggle audio on/off
    async toggleAudio() {
        if (!this.localStream) return;

        try {
            const audioTrack = this.localStream.getAudioTracks()[0];
            if (audioTrack) {
                this.isAudioEnabled = !this.isAudioEnabled;
                audioTrack.enabled = this.isAudioEnabled;
                
                // Update UI
                this.updateMediaButtons();
                console.log(`🎤 Audio ${this.isAudioEnabled ? 'enabled' : 'disabled'}`);
                
                // Send state update to peer
                this.sendMediaStateUpdate();
            }
        } catch (error) {
            console.error('❌ Toggle audio failed:', error);
        }
    },

    // Toggle screen sharing
    async toggleScreenShare() {
        try {
            if (!this.isScreenSharing) {
                // Start screen share
                this.screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: true,
                    audio: true
                });

                const videoTrack = this.screenStream.getVideoTracks()[0];
                
                // Replace the video track in the peer connection
                const sender = this.peerConnection.getSenders().find(s => 
                    s.track && s.track.kind === 'video'
                );
                
                if (sender) {
                    await sender.replaceTrack(videoTrack);
                    this.isScreenSharing = true;
                    
                    // Stop screen share when user stops it from browser UI
                    videoTrack.onended = () => {
                        this.toggleScreenShare();
                    };
                }

            } else {
                // Stop screen share and revert to camera
                const videoTrack = this.localStream.getVideoTracks()[0];
                const sender = this.peerConnection.getSenders().find(s => 
                    s.track && s.track.kind === 'video'
                );
                
                if (sender && videoTrack) {
                    await sender.replaceTrack(videoTrack);
                }
                
                if (this.screenStream) {
                    this.screenStream.getTracks().forEach(track => track.stop());
                    this.screenStream = null;
                }
                
                this.isScreenSharing = false;
            }

            this.updateMediaButtons();
            console.log(`🖥️ Screen sharing ${this.isScreenSharing ? 'enabled' : 'disabled'}`);

        } catch (error) {
            console.error('❌ Screen share failed:', error);
            alert('Screen sharing failed or was cancelled.');
        }
    },

    // Toggle remote audio (mute/unmute other person)
    toggleRemoteAudio() {
        const remoteVideo = document.getElementById('remote-video');
        if (remoteVideo) {
            remoteVideo.muted = !remoteVideo.muted;
            this.updateMediaButtons();
            console.log(`🔇 Remote audio ${remoteVideo.muted ? 'muted' : 'unmuted'}`);
        }
    },

    // Send media state update to peer
    sendMediaStateUpdate() {
        if (!this.currentCallId) return;

        Firestore.calls().doc(this.currentCallId).update({
            mediaState: {
                video: this.isVideoEnabled,
                audio: this.isAudioEnabled,
                screenShare: this.isScreenSharing,
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            }
        }).catch(console.error);
    },

    // Listen for media state updates from peer
    listenForMediaStateUpdates(callRef) {
        callRef.onSnapshot((snapshot) => {
            const data = snapshot.data();
            if (data && data.mediaState) {
                this.updateRemoteMediaState(data.mediaState);
            }
        });
    },

    // Update UI based on remote media state
    updateRemoteMediaState(mediaState) {
        const remoteVideo = document.getElementById('remote-video');
        const remoteStateEl = document.getElementById('remote-media-state');
        
        if (remoteStateEl) {
            let stateText = '';
            if (!mediaState.video) stateText += '📹 Video off ';
            if (!mediaState.audio) stateText += '🎤 Muted ';
            if (mediaState.screenShare) stateText += '🖥️ Sharing screen';
            
            remoteStateEl.textContent = stateText || 'Connected';
        }

        // Show/hide remote video placeholder based on video state
        const remoteVideoPlaceholder = document.getElementById('remote-video-placeholder');
        if (remoteVideoPlaceholder) {
            remoteVideoPlaceholder.style.display = mediaState.video ? 'none' : 'flex';
        }
    },

    // Update media control buttons
    updateMediaButtons() {
        const videoBtn = document.getElementById('toggle-video-btn');
        const audioBtn = document.getElementById('toggle-audio-btn');
        const screenShareBtn = document.getElementById('toggle-screen-share-btn');
        const muteRemoteBtn = document.getElementById('mute-remote-btn');
        const remoteVideo = document.getElementById('remote-video');

        if (videoBtn) {
            videoBtn.innerHTML = this.isVideoEnabled ? '📹' : '📹❌';
            videoBtn.title = this.isVideoEnabled ? 'Turn off camera' : 'Turn on camera';
        }

        if (audioBtn) {
            audioBtn.innerHTML = this.isAudioEnabled ? '🎤' : '🎤❌';
            audioBtn.title = this.isAudioEnabled ? 'Mute microphone' : 'Unmute microphone';
        }

        if (screenShareBtn) {
            screenShareBtn.innerHTML = this.isScreenSharing ? '🖥️⏹️' : '🖥️';
            screenShareBtn.title = this.isScreenSharing ? 'Stop screen share' : 'Share screen';
        }

        if (muteRemoteBtn && remoteVideo) {
            muteRemoteBtn.innerHTML = remoteVideo.muted ? '🔇' : '🔊';
            muteRemoteBtn.title = remoteVideo.muted ? 'Unmute remote' : 'Mute remote';
        }
    },

    // Start call timer
    startCallTimer() {
        this.callStartTime = new Date();
        this.callTimerInterval = setInterval(() => {
            this.updateCallTimer();
        }, 1000);
    },

    // Update call timer display
    updateCallTimer() {
        if (!this.callStartTime) return;

        const durationEl = document.getElementById('call-duration');
        if (durationEl) {
            const now = new Date();
            const diff = Math.floor((now - this.callStartTime) / 1000);
            const minutes = Math.floor(diff / 60);
            const seconds = diff % 60;
            durationEl.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
    },

    // Stop call timer
    stopCallTimer() {
        if (this.callTimerInterval) {
            clearInterval(this.callTimerInterval);
            this.callTimerInterval = null;
        }
        this.callStartTime = null;
    },

    // Toggle timer display format
    toggleTimerDisplay() {
        const durationEl = document.getElementById('call-duration');
        if (durationEl) {
            durationEl.classList.toggle('timer-seconds');
        }
    },

    // Create peer connection
    async createPeerConnection() {
        console.log("🔗 Creating peer connection...");
        this.peerConnection = new RTCPeerConnection(this.config);
        
        // Create remote stream
        this.remoteStream = new MediaStream();
        const remoteEl = document.getElementById('remote-video');
        if (remoteEl) {
            remoteEl.srcObject = this.remoteStream;
            remoteEl.muted = false;
        }

        // Add local tracks to connection
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
                console.log("🎯 Adding local track:", track.kind);
                this.peerConnection.addTrack(track, this.localStream);
            });
        }

        // Handle incoming tracks
        this.peerConnection.ontrack = (event) => {
            console.log("📹 Remote track received:", event.track.kind);
            if (event.streams && event.streams[0]) {
                const remoteEl = document.getElementById('remote-video');
                if (remoteEl) {
                    remoteEl.srcObject = event.streams[0];
                    console.log("✅ Remote stream attached to video element");
                }
            } else if (event.track) {
                this.remoteStream.addTrack(event.track);
                const remoteEl = document.getElementById('remote-video');
                if (remoteEl) {
                    remoteEl.srcObject = this.remoteStream;
                    console.log("✅ Remote track added to stream");
                }
            }
        };

        // Handle ICE candidates
        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                console.log("❄️ ICE candidate generated");
                this.sendIceCandidate(event.candidate);
            } else {
                console.log("✅ All ICE candidates gathered");
            }
        };

        // Handle connection state
        this.peerConnection.onconnectionstatechange = () => {
            console.log(`🔌 Connection state: ${this.peerConnection.connectionState}`);
            if (this.peerConnection.connectionState === 'connected') {
                console.log("✅ Call connected!");
                this.showCallConnected();
                this.stopRingtone();
                this.startCallTimer();
            } else if (this.peerConnection.connectionState === 'failed') {
                console.error("❌ Call connection failed");
                alert("Call connection failed. Please try again.");
                this.hangupCall();
            }
        };

        this.peerConnection.oniceconnectionstatechange = () => {
            console.log(`🧊 ICE connection state: ${this.peerConnection.iceConnectionState}`);
        };
    },

    // Start call as customer
    async startCallAsCustomer(videoEnabled = true, audioEnabled = true) {
        const user = firebase.auth().currentUser;
        if (!user) {
            alert('Please login to start a call');
            return;
        }

        try {
            console.log("📞 Starting call as customer...");
            this.isCaller = true;
            
            await this.prepareLocalMedia(videoEnabled, audioEnabled);
            await this.createPeerConnection();

            const callRef = Firestore.calls().doc();
            this.currentCallId = callRef.id;

            await callRef.set({
                callerId: user.uid,
                calleeId: "JIDFGUZI2qTo8nexGBjiOWM4sIy1",
                state: 'requested',
                mediaState: {
                    video: this.isVideoEnabled,
                    audio: this.isAudioEnabled,
                    screenShare: false
                },
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            const offerOptions = {
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            };
            
            const offer = await this.peerConnection.createOffer(offerOptions);
            await this.peerConnection.setLocalDescription(offer);

            await callRef.update({
                offer: {
                    type: offer.type,
                    sdp: offer.sdp
                },
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            console.log("✅ Call offer sent");
            
            this.playRingtone();
            this.listenForAnswer(callRef);
            this.listenForIceCandidates(callRef, 'answerCandidates');
            this.listenForMediaStateUpdates(callRef);

            this.showCallUI();
            this.showCallOptionsModal(false); // Show call options for outgoing call

        } catch (error) {
            console.error('❌ Call failed:', error);
            alert('Call failed: ' + error.message);
            this.cleanup();
        }
    },

    // Start call as admin
    async startCallAsAdmin(userId, videoEnabled = true, audioEnabled = true) {
        const user = firebase.auth().currentUser;
        if (!user) {
            alert('Please login as admin');
            return;
        }

        try {
            console.log("📞 Starting call as admin to:", userId);
            this.isCaller = true;
            
            await this.prepareLocalMedia(videoEnabled, audioEnabled);
            await this.createPeerConnection();

            const callRef = Firestore.calls().doc();
            this.currentCallId = callRef.id;

            await callRef.set({
                callerId: user.uid,
                calleeId: userId,
                state: 'requested',
                mediaState: {
                    video: this.isVideoEnabled,
                    audio: this.isAudioEnabled,
                    screenShare: false
                },
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            const offerOptions = {
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            };
            
            const offer = await this.peerConnection.createOffer(offerOptions);
            await this.peerConnection.setLocalDescription(offer);

            await callRef.update({
                offer: {
                    type: offer.type,
                    sdp: offer.sdp
                },
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            console.log("✅ Call offer sent to customer");
            
            this.playRingtone();
            this.listenForAnswer(callRef);
            this.listenForIceCandidates(callRef, 'answerCandidates');
            this.listenForMediaStateUpdates(callRef);

            this.showCallUI();
            this.showCallOptionsModal(false); // Show call options for outgoing call

        } catch (error) {
            console.error('❌ Admin call failed:', error);
            alert('Call failed: ' + error.message);
            this.cleanup();
        }
    },

    // Answer incoming call
    async answerCall(callId, videoEnabled = true, audioEnabled = true) {
        try {
            console.log("📞 Answering call:", callId);
            this.isCaller = false;
            this.currentCallId = callId;

            this.stopRingtone();

            const callRef = Firestore.calls().doc(callId);
            
            await this.prepareLocalMedia(videoEnabled, audioEnabled);
            await this.createPeerConnection();

            const callDoc = await callRef.get();
            const callData = callDoc.data();

            if (!callData.offer) {
                throw new Error('No offer found in call document');
            }

            await this.peerConnection.setRemoteDescription(
                new RTCSessionDescription(callData.offer)
            );

            const answerOptions = {
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            };
            
            const answer = await this.peerConnection.createAnswer(answerOptions);
            await this.peerConnection.setLocalDescription(answer);

            await callRef.update({
                answer: {
                    type: answer.type,
                    sdp: answer.sdp
                },
                state: 'accepted',
                mediaState: {
                    video: this.isVideoEnabled,
                    audio: this.isAudioEnabled,
                    screenShare: false
                },
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            console.log("✅ Call answered");

            this.listenForIceCandidates(callRef, 'offerCandidates');
            this.listenForMediaStateUpdates(callRef);

            this.showCallUI();

        } catch (error) {
            console.error('❌ Answer call failed:', error);
            alert('Failed to answer call: ' + error.message);
            this.cleanup();
        }
    },

    // Show call options modal for incoming call
    showCallOptionsModal(isIncoming = true) {
        const optionsModal = document.getElementById('call-options-modal');
        if (optionsModal) {
            optionsModal.style.display = 'flex';
            
            const title = optionsModal.querySelector('h3');
            if (title) {
                title.textContent = isIncoming ? 'Answer Call With...' : 'Start Call With...';
            }
            
            const videoCheckbox = document.getElementById('option-video');
            const audioCheckbox = document.getElementById('option-audio');
            
            if (videoCheckbox && audioCheckbox) {
                videoCheckbox.checked = this.isVideoEnabled;
                audioCheckbox.checked = this.isAudioEnabled;
            }
        }
    },

    // Hide call options modal
    hideCallOptionsModal() {
        const optionsModal = document.getElementById('call-options-modal');
        if (optionsModal) {
            optionsModal.style.display = 'none';
        }
    },

    // Listen for answer
    listenForAnswer(callRef) {
        callRef.onSnapshot(async (snapshot) => {
            const data = snapshot.data();
            if (!data) return;

            if (data.answer && !this.peerConnection.currentRemoteDescription) {
                console.log("✅ Answer received");
                try {
                    const answer = new RTCSessionDescription(data.answer);
                    await this.peerConnection.setRemoteDescription(answer);
                    console.log("✅ Remote description set from answer");
                    this.stopRingtone();
                    this.hideCallOptionsModal();
                } catch (error) {
                    console.error('❌ Error setting remote description:', error);
                }
            }

            if (data.state === 'ended') {
                console.log("📞 Call ended by remote party");
                this.stopRingtone();
                this.hangupCall();
            }
        });
    },

    // Listen for ICE candidates
    listenForIceCandidates(callRef, candidateType) {
        callRef.collection(candidateType).onSnapshot((snapshot) => {
            snapshot.docChanges().forEach(async (change) => {
                if (change.type === 'added') {
                    try {
                        const candidate = new RTCIceCandidate(change.doc.data());
                        await this.peerConnection.addIceCandidate(candidate);
                        console.log("❄️ ICE candidate added:", candidateType);
                    } catch (error) {
                        console.error('❌ Error adding ICE candidate:', error);
                    }
                }
            });
        });
    },

    // Send ICE candidate
    async sendIceCandidate(candidate) {
        if (!this.currentCallId) return;

        try {
            const callRef = Firestore.calls().doc(this.currentCallId);
            const candidateData = candidate.toJSON();
            
            const collectionName = this.isCaller ? 'offerCandidates' : 'answerCandidates';
            await callRef.collection(collectionName).add(candidateData);
            console.log("❄️ ICE candidate sent to", collectionName);
        } catch (error) {
            console.error('❌ Error sending ICE candidate:', error);
        }
    },

    // Show call connected state
    showCallConnected() {
        const modal = document.getElementById('call-modal');
        if (modal) {
            const title = modal.querySelector('h3');
            if (title) {
                title.textContent += ' (Connected)';
            }
        }
        
        const remoteVideo = document.getElementById('remote-video');
        if (remoteVideo && remoteVideo.paused) {
            remoteVideo.play().catch(console.error);
        }
        
        this.updateMediaButtons();
    },

    // Hang up call
    async hangupCall() {
        console.log("📞 Hanging up call...");
        this.stopRingtone();
        this.stopCallTimer();
        this.cleanup();
    },

    // Cleanup resources
    cleanup() {
        try {
            if (this.peerConnection) {
                this.peerConnection.close();
                this.peerConnection = null;
            }

            if (this.localStream) {
                this.localStream.getTracks().forEach(track => {
                    track.stop();
                    console.log("🛑 Stopped local track:", track.kind);
                });
                this.localStream = null;
            }

            if (this.remoteStream) {
                this.remoteStream.getTracks().forEach(track => {
                    track.stop();
                    console.log("🛑 Stopped remote track:", track.kind);
                });
                this.remoteStream = null;
            }

            if (this.screenStream) {
                this.screenStream.getTracks().forEach(track => track.stop());
                this.screenStream = null;
            }

            if (this.currentCallId) {
                Firestore.calls().doc(this.currentCallId).update({
                    state: 'ended',
                    endedAt: firebase.firestore.FieldValue.serverTimestamp()
                }).catch(console.error);
                this.currentCallId = null;
            }

            this.stopRingtone();
            this.stopCallTimer();
            this.hideCallUI();
            this.hideCallOptionsModal();
            console.log("✅ Call cleanup completed");

        } catch (error) {
            console.error('❌ Error during cleanup:', error);
        }
    },

    // Listen for incoming calls
    listenForIncomingCalls() {
        const user = firebase.auth().currentUser;
        if (!user) return;

        console.log("👂 Listening for incoming calls...");

        Firestore.calls()
            .where('calleeId', '==', user.uid)
            .where('state', '==', 'requested')
            .onSnapshot((snapshot) => {
                snapshot.docChanges().forEach((change) => {
                    if (change.type === 'added') {
                        console.log("📞 Incoming call detected:", change.doc.id);
                        this.handleIncomingCall(change.doc.id, change.doc.data());
                    }
                });
            });
    },

    // Handle incoming call
    handleIncomingCall(callId, callData) {
        console.log("📞 Handling incoming call:", callId);
        
        window.currentIncomingCallId = callId;
        
        const callerName = callData.callerName || 'Customer';
        const isAdmin = document.getElementById('admin-orders');
        
        if (isAdmin) {
            this.playRingtone();
            this.showCallOptionsModal(true); // Show options for incoming call
        } else {
            this.playRingtone();
            this.showIncomingCallNotification(callerName);
        }
    },

    // Show incoming call notification with options
    showIncomingCallNotification(callerName) {
        const incomingCallBox = document.getElementById('incoming-call-box');
        if (incomingCallBox) {
            incomingCallBox.innerHTML = `
                <p>📞 Incoming call from ${callerName}</p>
                <div style="margin: 10px 0;">
                    <label style="display: block; margin: 5px 0;">
                        <input type="checkbox" id="incoming-video" checked> Video
                    </label>
                    <label style="display: block; margin: 5px 0;">
                        <input type="checkbox" id="incoming-audio" checked> Audio
                    </label>
                </div>
                <div style="display: flex; gap: 10px; justify-content: center;">
                    <button onclick="answerIncomingCallWithOptions()" class="btn primary">Answer</button>
                    <button onclick="declineIncomingCall()" class="btn ghost">Decline</button>
                </div>
            `;
            incomingCallBox.style.display = 'block';
        }
    },

    // Decline call
    async declineCall(callId) {
        this.stopRingtone();
        await Firestore.calls().doc(callId).update({
            state: 'declined',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        console.log("📞 Call declined");
    },

    // UI Management
    showCallUI() {
        const modal = document.getElementById('call-modal');
        if (modal) {
            modal.style.display = 'flex';
            console.log("✅ Call UI shown");
        }
        
        this.updateCallButtons(true);
        this.updateMediaButtons();
    },

    hideCallUI() {
        const modal = document.getElementById('call-modal');
        if (modal) {
            modal.style.display = 'none';
        }

        const remoteVideo = document.getElementById('remote-video');
        const localVideo = document.getElementById('local-video');
        
        if (remoteVideo) {
            remoteVideo.srcObject = null;
            remoteVideo.load();
        }
        if (localVideo) {
            localVideo.srcObject = null;
            localVideo.load();
        }
        
        this.updateCallButtons(false);
        console.log("✅ Call UI hidden");
    },

    updateCallButtons(isInCall) {
        const callBtn = document.getElementById('btn-call');
        const hangupBtn = document.getElementById('btn-hangup');
        
        if (callBtn) callBtn.style.display = isInCall ? 'none' : 'block';
        if (hangupBtn) hangupBtn.style.display = isInCall ? 'block' : 'none';
    }
};

// Initialize call manager when page loads
window.addEventListener('load', () => {
    setTimeout(() => {
        CallManager.init();
    }, 1000);
});

/* ---------- Enhanced Public Call Functions ---------- */
function startCallToAdmin() {
    // Show options before starting call
    CallManager.showCallOptionsModal(false);
}

function startCallAsAdmin(userId) {
    // Show options before starting call
    CallManager.showCallOptionsModal(false);
    // Store the user ID for later use
    window.pendingAdminCallUserId = userId;
}

function acceptCall(callId) {
    CallManager.answerCall(callId);
}

function endCall() {
    CallManager.hangupCall();
}

function answerIncomingCall() {
    if (window.currentIncomingCallId) {
        CallManager.stopRingtone();
        CallManager.answerCall(window.currentIncomingCallId, true, true); // Default with video and audio
        const incomingCallBox = document.getElementById('incoming-call-box');
        if (incomingCallBox) incomingCallBox.style.display = 'none';
        window.currentIncomingCallId = null;
    }
}

function answerIncomingCallWithOptions() {
    if (window.currentIncomingCallId) {
        const videoEnabled = document.getElementById('incoming-video')?.checked ?? true;
        const audioEnabled = document.getElementById('incoming-audio')?.checked ?? true;
        
        CallManager.stopRingtone();
        CallManager.answerCall(window.currentIncomingCallId, videoEnabled, audioEnabled);
        const incomingCallBox = document.getElementById('incoming-call-box');
        if (incomingCallBox) incomingCallBox.style.display = 'none';
        window.currentIncomingCallId = null;
    }
}

function declineIncomingCall() {
    if (window.currentIncomingCallId) {
        CallManager.stopRingtone();
        CallManager.declineCall(window.currentIncomingCallId);
        const incomingCallBox = document.getElementById('incoming-call-box');
        if (incomingCallBox) incomingCallBox.style.display = 'none';
        window.currentIncomingCallId = null;
    }
}

function startCallWithOptions() {
    const videoEnabled = document.getElementById('option-video')?.checked ?? true;
    const audioEnabled = document.getElementById('option-audio')?.checked ?? true;
    
    CallManager.hideCallOptionsModal();
    
    if (window.pendingAdminCallUserId) {
        // Admin calling a customer
        CallManager.startCallAsAdmin(window.pendingAdminCallUserId, videoEnabled, audioEnabled);
        window.pendingAdminCallUserId = null;
    } else {
        // Customer calling admin
        CallManager.startCallAsCustomer(videoEnabled, audioEnabled);
    }
}

function cancelCallWithOptions() {
    CallManager.hideCallOptionsModal();
    window.pendingAdminCallUserId = null;
    CallManager.stopRingtone();
}

function listenForCallRequests() {
    console.log("📞 Call listener activated");
}

// Add these new functions for the upgraded features
function toggleVideo() {
    CallManager.toggleVideo();
}

function toggleAudio() {
    CallManager.toggleAudio();
}

function toggleScreenShare() {
    CallManager.toggleScreenShare();
}

function toggleRemoteAudio() {
    CallManager.toggleRemoteAudio();
}

/* ---------- CUSTOMER-side chat ---------- */
function startCustomerChat(userId, displayName = null) {
    if (customerChatUnsub) { 
        try { customerChatUnsub(); } catch(e){} 
        customerChatUnsub = null; 
    }

    const messagesBox = DOM.q('#chat-messages');
    if (!messagesBox) return;

    // Ensure parent chat doc exists
    Firestore.chats().doc(userId).set({
        userId,
        name: displayName || '',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true }).catch(err => console.error('init chat doc failed', err));

    const colRef = Firestore.chats().doc(userId).collection('messages');
    const q = colRef.orderBy('timestamp','asc');

    customerChatUnsub = q.onSnapshot(snapshot => {
        messagesBox.innerHTML = '';
        if (snapshot.empty) {
            messagesBox.innerHTML = `<div style="padding:12px;color:#ddd">No messages yet. Say hi 👋</div>`;
            return;
        }
        snapshot.forEach(doc => {
            const m = doc.data();
            appendCustomerMessageToUI(messagesBox, m);
        });

        // mark admin messages as read by customer
        markMessagesReadForCustomer(userId).catch(()=>{});
        messagesBox.scrollTo({ top: messagesBox.scrollHeight, behavior: 'smooth' });
    }, err => {
        console.error('customer messages listener error', err);
        messagesBox.innerHTML = `<div style="padding:12px;color:#f66">Failed to load messages.</div>`;
    });

    window.addEventListener('beforeunload', () => {
        Firestore.chats().doc(userId).set({ typing: false }, { merge: true }).catch(()=>{});
    });
}

function appendCustomerMessageToUI(container, m) {
    const time = m.timestamp ? m.timestamp.toDate().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '';
    const wrap = document.createElement('div');
    wrap.style.marginBottom = '8px';
    wrap.style.textAlign = (m.sender === 'customer') ? 'right' : 'left';

    const bubble = document.createElement('span');
    bubble.textContent = m.message;
    bubble.style.display = 'inline-block';
    bubble.style.padding = '8px 12px';
    bubble.style.borderRadius = '12px';
    bubble.style.maxWidth = '78%';
    bubble.style.wordBreak = 'break-word';
    bubble.style.background = (m.sender === 'customer') ? '#3498db' : '#444';
    bubble.style.color = '#fff';

    const timeEl = document.createElement('div');
    timeEl.textContent = time;
    timeEl.style.fontSize = '0.75rem';
    timeEl.style.opacity = '0.7';
    timeEl.style.marginTop = '4px';

    wrap.appendChild(bubble);
    wrap.appendChild(timeEl);
    container.appendChild(wrap);
}

async function markMessagesReadForCustomer(userId) {
    const msgsSnap = await Firestore.chats().doc(userId).collection('messages')
        .where('sender','==','admin')
        .where('readByCustomer','==',false)
        .get();
    if (msgsSnap.empty) return;
    const batch = db.batch();
    msgsSnap.forEach(d => batch.update(d.ref, { readByCustomer: true }));
    await batch.commit();
}

function sendChat() {
    const input = DOM.q('#chat-input');
    if (!input) return;
    const message = input.value.trim();
    if (!message) return;

    const user = firebase.auth().currentUser;
    if (!user) { alert('Please login to chat.'); return; }

    const chatDocRef = Firestore.chats().doc(user.uid);
    const messagesRef = chatDocRef.collection('messages');
    const nameToSave = user.displayName || (user.email ? user.email.split('@')[0] : 'Customer');

    chatDocRef.set({
        userId: user.uid,
        name: nameToSave,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        unreadForAdmin: true
    }, { merge: true })
    .then(() => messagesRef.add({
        sender: 'customer',
        message,
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        readByAdmin: false,
        readByCustomer: true
    }))
    .then(() => {
        input.value = '';
        // collapse typing
        chatDocRef.set({ typing: false }, { merge: true }).catch(()=>{});
    })
    .catch(err => {
        console.error('sendChat error', err);
        alert('Failed to send message. Check console.');
    });
}

function debounceCustomerTyping() {
    const user = firebase.auth().currentUser;
    if (!user) return;
    const chatDocRef = Firestore.chats().doc(user.uid);
    chatDocRef.set({ typing: true }, { merge: true }).catch(()=>{});
    if (typingTimer) clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
        chatDocRef.set({ typing: false }, { merge: true }).catch(()=>{});
    }, TYPING_DEBOUNCE_MS);
}

/* ---------- ADMIN-side chat (UI + functions) ---------- */
async function renderAdminUserList(snapshot){
    const listEl = DOM.q('#chat-users'); 
    if(!listEl) return;
    
    if (snapshot.empty) {
        listEl.innerHTML = '<div style="padding:12px;color:#ddd">No chat users yet.</div>';
        updateGlobalNotifBadge(0);
        return;
    }

    const docs = [];
    snapshot.forEach(d => docs.push({ id: d.id, ...d.data() }));

    // parallel fetch unread counts & last message per chat
    const unreadPromises = docs.map(d => Firestore.chats().doc(d.id).collection('messages')
                                      .where('sender','==','customer').where('readByAdmin','==',false).get()
                                      .then(s => ({ id: d.id, unread: s.size })).catch(()=>({id:d.id, unread:0})));
    const lastPromises = docs.map(d => Firestore.chats().doc(d.id).collection('messages')
                                      .orderBy('timestamp','desc').limit(1).get()
                                      .then(s => ({ id: d.id, last: s.empty ? null : s.docs[0].data() })).catch(()=>({id:d.id,last:null})));

    const unreadResults = await Promise.all(unreadPromises);
    const lastResults = await Promise.all(lastPromises);
    const unreadMap = Object.fromEntries(unreadResults.map(x => [x.id, x.unread]));
    const lastMap = Object.fromEntries(lastResults.map(x => [x.id, x.last]));

    const html = docs.map(d => {
        const name = d.name || d.username || d.userId || d.id;
        const initials = (name.split(' ').map(p => p[0]).join('').slice(0,2) || 'U').toUpperCase();
        const last = lastMap[d.id];
        const preview = last ? (last.message.length > 40 ? last.message.slice(0,37) + '...' : last.message) : 'No messages';
        const ts = last && last.timestamp ? Formatter.time(last.timestamp) : '';
        const unread = unreadMap[d.id] || 0;
        chatUsersCache[d.id] = { name, initials, preview, ts, unread };
        const activeStyle = (currentAdminChatUser === d.id) ? 'background:#18314a;border:1px solid #234455;' : '';
        return `
            <div class="chat-user-row" style="display:flex;align-items:center;gap:10px;padding:8px;border-radius:10px;${activeStyle}" data-uid="${d.id}">
                <div style="width:44px;height:44px;border-radius:50%;background:#2f80ed;display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff">${initials}</div>
                <div style="flex:1;min-width:0">
                    <div style="font-weight:700;color:#eee">${Formatter.escapeHtml(name)}</div>
                    <div style="font-size:0.85rem;color:#9aa0a6">${Formatter.escapeHtml(preview)} · <span style="color:#6d7880">${Formatter.escapeHtml(ts)}</span></div>
                </div>
                <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
                    ${unread>0?`<div class="user-unread" style="background:#e74c3c;color:#fff;padding:4px 8px;border-radius:999px;font-weight:700">${unread}</div>`:''}
                    <div style="display:flex;gap:6px">
                        <button class="btn small" onclick="openAdminChat('${d.id}')">Open</button>
                        <button class="btn small ghost" onclick="startCallAsAdmin('${d.id}')">Call</button>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    listEl.innerHTML = html;

    // update global unread badge
    const totalUnread = Object.values(unreadMap).reduce((s,n)=>s+n,0);
    updateGlobalNotifBadge(totalUnread);

    // wire row click to open chat (excluding clicking the buttons)
    listEl.querySelectorAll('[data-uid]').forEach(el => {
        el.addEventListener('click', (ev) => {
            if (ev.target.tagName.toLowerCase() === 'button') return;
            const uid = el.getAttribute('data-uid');
            openAdminChat(uid);
        });
    });
}

function loadChatUsersRealtime(){
    const listEl = DOM.q('#chat-users'); 
    if (!listEl) return;
    
    if (adminUsersUnsub) { 
        try { adminUsersUnsub(); } catch(e){} 
        adminUsersUnsub = null; 
    }

    adminUsersUnsub = Firestore.chats().orderBy('updatedAt','desc').onSnapshot(async snap => {
        try { await renderAdminUserList(snap); } catch(err){ console.error('renderAdminUserList', err); }
    }, err => {
        console.error('loadChatUsersRealtime', err);
        listEl.innerHTML = '<div style="padding:12px;color:#f66">Failed to load users.</div>';
    });

    // optional: search input handling
    const search = DOM.q('#chat-search');
    if (search) search.addEventListener('input', Utils.debounce(()=> {
        const qv = search.value.trim().toLowerCase();
        DOM.qAll('#chat-users .chat-user-row').forEach(btn => {
            const uid = btn.getAttribute('data-uid');
            const info = chatUsersCache[uid] || {};
            const match = (info.name || '').toLowerCase().includes(qv) || (info.preview || '').toLowerCase().includes(qv) || uid.includes(qv);
            btn.style.display = match ? 'flex' : 'none';
        });
    }, 200));
}

async function openAdminChat(userId){
    currentAdminChatUser = userId;
    const messagesBox = DOM.q('#chat-admin-messages');
    if (!messagesBox) return;

    // update chat header
    const withEl = DOM.q('#chat-with');
    if (withEl) {
        try {
            const doc = await Firestore.chats().doc(userId).get();
            const data = doc.data() || {};
            withEl.textContent = "Chat with: " + (data.name || userId);
        } catch (err) { console.error(err); }
    }

    // mark unread messages as read by admin
    await markMessagesReadForAdmin(userId);
    // attach listener for messages
    attachAdminMessagesListener(userId);
    // ensure chat-admin-box is visible
    const boxWrap = DOM.q('#chat-admin-box');
    if (boxWrap) boxWrap.style.display = 'block';
}

function attachAdminMessagesListener(userId) {
    if (adminMessagesUnsub) { 
        try { adminMessagesUnsub(); } catch(e){} 
        adminMessagesUnsub = null; 
    }

    const box = DOM.q('#chat-admin-messages'); 
    if (!box) return;
    
    box.innerHTML = '<div style="padding:8px;color:#ddd">Loading messages…</div>';

    const q = Firestore.chats().doc(userId).collection('messages').orderBy('timestamp','asc');
    adminMessagesUnsub = q.onSnapshot(snapshot => {
        box.innerHTML = '';
        if (snapshot.empty) { 
            box.innerHTML = '<div style="padding:12px;color:#ddd">No messages yet.</div>'; 
            return; 
        }
        snapshot.forEach(doc => {
            const m = doc.data();
            const wrapper = document.createElement('div');
            wrapper.style.display = 'flex';
            wrapper.style.flexDirection = 'column';
            wrapper.style.alignItems = (m.sender === 'admin') ? 'flex-end' : 'flex-start';

            const bubble = document.createElement('div');
            bubble.className = 'bubble ' + (m.sender === 'admin' ? 'admin' : 'customer');
            bubble.textContent = m.message;
            bubble.style.padding = '8px 12px';
            bubble.style.borderRadius = '12px';
            bubble.style.maxWidth = '78%';
            bubble.style.wordBreak = 'break-word';

            const t = document.createElement('div');
            t.className = 'msg-time';
            t.style.fontSize = '0.75rem';
            t.style.opacity = '0.7';
            t.style.marginTop = '4px';
            t.textContent = Formatter.time(m.timestamp);

            wrapper.appendChild(bubble);
            wrapper.appendChild(t);
            box.appendChild(wrapper);
        });
        box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
    }, err => {
        console.error('attachAdminMessagesListener', err);
        box.innerHTML = '<div style="padding:12px;color:#f66">Failed to load messages.</div>';
    });
}

function adminSendChat(){
    const input = DOM.q('#admin-chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    const uid = currentAdminChatUser;
    if (!uid) { alert('Select a user first'); return; }
    const chatRef = Firestore.chats().doc(uid);
    const messagesRef = chatRef.collection('messages');

    messagesRef.add({
        sender: 'admin',
        message: text,
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        readByAdmin: true,
        readByCustomer: false
    }).then(() => {
        chatRef.set({ unreadForAdmin: false, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
        input.value = '';
    }).catch(err => {
        console.error('adminSendChat', err);
        alert('Failed to send message.');
    });
}

async function markMessagesReadForAdmin(userId){
    if (!userId) return;
    try {
        const q = Firestore.chats().doc(userId).collection('messages')
            .where('sender','==','customer').where('readByAdmin','==',false);
        const snap = await q.get();
        if (snap.empty) {
            // ensure parent flag is false
            await Firestore.chats().doc(userId).set({ unreadForAdmin: false }, { merge: true });
            return;
        }
        const batch = db.batch();
        snap.forEach(d => batch.update(d.ref, { readByAdmin: true }));
        batch.update(Firestore.chats().doc(userId), { unreadForAdmin: false });
        await batch.commit();
    } catch (err) {
        console.error('markMessagesReadForAdmin', err);
    }
}

function closeChat(){
    currentAdminChatUser = null;
    if (adminMessagesUnsub) { 
        try { adminMessagesUnsub(); } catch(e){} 
        adminMessagesUnsub = null; 
    }
    const boxWrap = DOM.q('#chat-admin-box'); 
    if (boxWrap) boxWrap.style.display = 'none';
    const cam = DOM.q('#chat-admin-messages'); 
    if (cam) cam.innerHTML = '';
    // refresh users list
    Firestore.chats().get().then(snap => renderAdminUserList(snap)).catch(()=>{});
}

function updateGlobalNotifBadge(count){
    const badge = DOM.q('#chat-notif');
    if (!badge) return;
    if (count > 0) { 
        badge.style.display = 'inline-block'; 
        badge.textContent = count > 99 ? '99+' : String(count); 
    } else { 
        badge.style.display = 'none'; 
        badge.textContent = ''; 
    }
}

/* ---------- Notifications & watchers ---------- */
function startGlobalNotificationWatcher(){
    try {
        // listen to recent messages across chats for notifications
        db.collectionGroup('messages').orderBy('timestamp','desc').limit(50).onSnapshot(snap => {
            snap.docChanges().forEach(change => {
                if (change.type !== 'added') return;
                const m = change.doc.data();
                if (!m || m.sender !== 'customer') return;
                const pathParts = change.doc.ref.path.split('/'); // ['chats','{uid}','messages','{msgId}']
                const uid = pathParts[1];
                notifyAdminOfIncomingMessage(uid, m.name || 'Customer', m.message);
                // bump badge quickly
                const badge = DOM.q('#chat-notif');
                if (badge) {
                    const curr = badge.style.display === 'inline-block' ? (Number(badge.textContent.replace('+','')) || 0) : 0;
                    updateGlobalNotifBadge(curr + 1);
                }
            });
        }, err => {
            console.warn('global watcher err', err);
        });
    } catch (e) {
        // collectionGroup may be blocked by rules or plan; ignore gracefully
        console.warn('collectionGroup watcher not supported or failed', e);
    }
}

function notifyAdminOfIncomingMessage(userId, name, message){
    try {
        if (!('Notification' in window)) return;
        if (Notification.permission !== 'granted') return;
        const isActive = (document.visibilityState === 'visible') && (currentAdminChatUser === userId);
        if (isActive) return;
        const n = new Notification(name || 'Customer', {
            body: message.length > 100 ? message.slice(0,97) + '...' : message,
            tag: `chat-${userId}`,
            renotify: true
        });
        n.onclick = () => { window.focus(); openAdminChat(userId); n.close(); };
    } catch (err) { /* ignore */ }
}

/* ---------------------- Legacy chat helper ---------------------- */
function toggleChatBox() {
    const box = DOM.q("#chat-box");
    if (!box) return;
    box.style.display = box.style.display === "none" || box.style.display === "" ? "flex" : "none";
    if (box.style.display === "flex") {
        const messages = DOM.q("#chat-messages");
        setTimeout(() => { 
            if (messages) messages.scrollTo({ top: messages.scrollHeight, behavior: 'smooth' }); 
        }, 150);
    }
}

/* ---------------------- Auth: signup/login/logout ---------------------- */
async function signupUser(e){
    e.preventDefault();
    const username = (DOM.q('#signup-username')||{}).value?.trim();
    const email = (DOM.q('#signup-email')||{}).value?.trim();
    const password = (DOM.q('#signup-password')||{}).value;
    if (!username || !email || !password) { alert('Complete all fields'); return false; }
    try {
        const cred = await auth.createUserWithEmailAndPassword(email, password);
        const uid = cred.user.uid;
        await Firestore.users().doc(uid).set({
            username,
            email,
            role: 'customer',
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        alert('Account created. Redirecting to store...');
        window.location.href = 'index.html';
    } catch (err) { console.error(err); alert(err.message || 'Signup failed'); }
    return false;
}

async function loginUser(e){
    e.preventDefault();
    const email = (DOM.q('#login-username')||{}).value?.trim();
    const password = (DOM.q('#login-password')||{}).value;
    if (!email || !password) { alert('Complete fields'); return false; }
    try { await auth.signInWithEmailAndPassword(email, password); } 
    catch (err) { console.error(err); alert(err.message || 'Login failed'); }
    return false;
}

function logoutUser(){ auth.signOut(); }

/* ---------- auth state & UI ---------- */
function bindAuthState(){
    auth.onAuthStateChanged(async user => {
        const welcome = DOM.q('#welcome-user-top');
        const loginLink = DOM.q('#login-link');
        const signupLink = DOM.q('#signup-link');
        const adminLink = DOM.q('#admin-link');
        if (user) {
            try {
                const doc = await Firestore.users().doc(user.uid).get();
                const username = doc.exists ? (doc.data().username || user.email.split('@')[0]) : user.email.split('@')[0];
                if (welcome) welcome.textContent = `Hi, ${username}`;
                if (loginLink) loginLink.style.display = 'none';
                if (signupLink) signupLink.style.display = 'none';
                if (doc.exists && doc.data().role === 'admin') {
                    if (adminLink) adminLink.style.display = 'inline-block';
                    if (location.pathname.endsWith('login.html')) window.location.href = 'admin.html';
                }
            } catch (err) { console.error('Failed to read user doc', err); }
        } else {
            if (welcome) welcome.textContent = '';
            if (loginLink) loginLink.style.display = 'inline-block';
            if (signupLink) signupLink.style.display = 'inline-block';
            if (adminLink) adminLink.style.display = 'none';
        }
    });
}

/* ---------- INDEX PAGE: products listing ---------- */
let lastProducts = [];
function initIndex(){
    if (!DOM.q('#catalog')) return;

    Firestore.products().orderBy('createdAt','desc').onSnapshot(snapshot => {
        const arr = [];
        snapshot.forEach(doc => arr.push({ id: doc.id, ...doc.data() }));
        lastProducts = arr;
        renderProducts(arr);
        populateFilters(arr);
    }, err => console.error('products listener error', err));

    const search = DOM.q('#search-input'); 
    if (search) search.addEventListener('input', Utils.debounce(applyFilters,150));
    
    const cat = DOM.q('#category-filter'); 
    if (cat) cat.addEventListener('change', applyFilters);
    
    const sort = DOM.q('#sort-select'); 
    if (sort) sort.addEventListener('change', applyFilters);

    const cartBtn = DOM.q('#cart-btn'); 
    if (cartBtn) cartBtn.addEventListener('click', ()=>toggleCart(true));

    renderCartCount();
}

function renderProducts(list){
    const container = DOM.q('#catalog'); 
    if (!container) return;
    
    container.innerHTML = list.map(p => `
        <article class="card-product" data-id="${p.id}">
            <img src="${p.imgUrl || p.img || Utils.placeholderDataURL(p.title)}" alt="${Formatter.escapeHtml(p.title)}" onclick="openProductModal('${p.id}')" />
            <h4>${Formatter.escapeHtml(p.title)}</h4>
            <div class="meta">
                <div class="price">${Formatter.money(p.price)}</div>
                <div class="muted small">${Formatter.escapeHtml(p.category)}</div>
            </div>
            <div class="muted small">${Formatter.escapeHtml(p.desc||'')}</div>
            <div class="card-actions">
                <button class="btn" onclick="openProductModal('${p.id}')">View</button>
                <button class="btn primary" onclick="addToCartById('${p.id}',1)">Add to cart</button>
            </div>
        </article>
    `).join('');
    applyFilters();
}

function populateFilters(list){
    list = list || lastProducts || [];
    const categories = Array.from(new Set(list.map(x=>x.category).filter(Boolean)));
    const sel = DOM.q('#category-filter'); 
    if (!sel) return;
    
    sel.innerHTML = `<option value="">All categories</option>` + 
                   categories.map(c=>`<option value="${Formatter.escapeHtml(c)}">${Formatter.escapeHtml(c)}</option>`).join('');
}

function applyFilters(){
    const qv = (DOM.q('#search-input')||{}).value?.trim().toLowerCase() || '';
    const cat = (DOM.q('#category-filter')||{}).value || '';
    const sort = (DOM.q('#sort-select')||{}).value || 'popular';
    let list = lastProducts.slice();
    
    if (qv) list = list.filter(p => (p.title||'').toLowerCase().includes(qv) || (p.desc||'').toLowerCase().includes(qv));
    if (cat) list = list.filter(p => p.category === cat);
    if (sort==='price-asc') list.sort((a,b)=>a.price-b.price);
    if (sort==='price-desc') list.sort((a,b)=>b.price-a.price);
    if (sort==='newest') list.sort((a,b)=>b.createdAt?.seconds - a.createdAt?.seconds);
    
    const container = DOM.q('#catalog'); 
    if (!container) return;
    
    container.innerHTML = list.map(p => `
        <article class="card-product" data-id="${p.id}">
            <img src="${p.imgUrl || p.img || Utils.placeholderDataURL(p.title)}" alt="${Formatter.escapeHtml(p.title)}" onclick="openProductModal('${p.id}')" />
            <h4>${Formatter.escapeHtml(p.title)}</h4>
            <div class="meta">
                <div class="price">${Formatter.money(p.price)}</div>
                <div class="muted small">${Formatter.escapeHtml(p.category)}</div>
            </div>
            <div class="muted small">${Formatter.escapeHtml(p.desc||'')}</div>
            <div class="card-actions">
                <button class="btn" onclick="openProductModal('${p.id}')">View</button>
                <button class="btn primary" onclick="addToCartById('${p.id}',1)">Add to cart</button>
            </div>
        </article>
    `).join('');
}

/* ---------- Product modal ---------- */
async function openProductModal(id){
    try {
        const doc = await Firestore.products().doc(id).get();
        if (!doc.exists) return alert('Product not found');
        const p = { id: doc.id, ...doc.data() };
        const el = DOM.q('#product-detail');
        el.innerHTML = `
            <div style="display:flex;gap:18px;flex-wrap:wrap">
                <div style="flex:1;min-width:260px">
                    <img src="${p.imgUrl || p.img || Utils.placeholderDataURL(p.title)}" style="width:100%;border-radius:10px;object-fit:cover"/>
                </div>
                <div style="flex:1;min-width:260px">
                    <h2>${Formatter.escapeHtml(p.title)}</h2>
                    <div class="muted">${Formatter.escapeHtml(p.category)}</div>
                    <p style="margin:12px 0;color:#ddd">${Formatter.escapeHtml(p.desc||'')}</p>
                    <div style="font-size:1.2rem;font-weight:700">${Formatter.money(p.price)}</div>
                    <div style="margin-top:12px;display:flex;gap:8px">
                        <button class="btn primary" onclick="addToCartById('${p.id}',1);closeProductModal()">Add to cart</button>
                        <button class="btn ghost" onclick="closeProductModal()">Close</button>
                    </div>
                </div>
            </div>
        `;
        const modal = DOM.q('#product-modal'); 
        if(modal){ 
            modal.style.display = 'flex'; 
            modal.setAttribute('aria-hidden','false'); 
        }
    } catch (err) { 
        console.error(err); 
        alert('Open product failed'); 
    }
}

function closeProductModal(){ 
    const m = DOM.q('#product-modal'); 
    if (m){ 
        m.style.display='none'; 
        m.setAttribute('aria-hidden','true'); 
    } 
}

/* ---------- Cart ---------- */
function getCart(){ 
    try { 
        return JSON.parse(localStorage.getItem('ct_cart')||'[]'); 
    } catch(e){ 
        return []; 
    } 
}

function saveCart(c){ 
    localStorage.setItem('ct_cart', JSON.stringify(c)); 
    renderCartCount(); 
}

function renderCartCount(){ 
    const el = DOM.q('#cart-count'); 
    if (!el) return; 
    const c = getCart().reduce((s,i)=>s+(i.qty||1),0); 
    el.textContent = c; 
}

function addToCartById(id, qty=1){ 
    const cart = getCart(); 
    const ex = cart.find(i=>i.id===id); 
    if (ex) ex.qty+=qty; 
    else cart.push({id, qty}); 
    saveCart(cart); 
    toggleCart(true); 
    renderCartUI(); 
}

function changeQty(id, delta){ 
    const cart = getCart(); 
    const it = cart.find(i=>i.id===id); 
    if(!it) return; 
    it.qty+=delta; 
    if(it.qty<=0){ 
        if(!confirm('Remove item?')){ 
            it.qty=1; 
        }else{ 
            cart.splice(cart.findIndex(i=>i.id===id),1); 
        } 
    } 
    saveCart(cart); 
    renderCartUI(); 
}

function removeFromCart(id){ 
    const cart=getCart().filter(i=>i.id!==id); 
    saveCart(cart); 
    renderCartUI(); 
}

function toggleCart(show){ 
    const panel = DOM.q('#cart-panel'); 
    if(!panel) return; 
    panel.style.display=show?'flex':'none'; 
    if(show) renderCartUI(); 
}

function renderCartUI(){
    const container = DOM.q('#cart-items'); 
    if(!container) return;
    
    const cart = getCart();
    if(cart.length===0){ 
        container.innerHTML=`<div style="padding:18px;color:var(--muted)">Your cart is empty.</div>`; 
        const totalEl = DOM.q('#cart-total');
        if(totalEl) totalEl.textContent = Formatter.money(0); 
        return; 
    }
    
    Promise.all(cart.map(ci=>Firestore.products().doc(ci.id).get())).then(docs=>{
        const items = docs.map((doc,idx)=>({id:doc.id, ...(doc.data()||{}), qty: cart[idx].qty}));
        container.innerHTML = items.map(it=>`
            <div class="cart-item" data-id="${it.id}">
                <img src="${it.imgUrl || it.img || Utils.placeholderDataURL(it.title)}" alt="${Formatter.escapeHtml(it.title)}" />
                <div class="info">
                    <div style="display:flex;justify-content:space-between">
                        <div>${Formatter.escapeHtml(it.title)}</div>
                        <div class="muted">${Formatter.money(it.price)}</div>
                    </div>
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px">
                        <div style="display:flex;align-items:center;gap:8px">
                            <button class="btn small" onclick="changeQty('${it.id}',-1)">−</button>
                            <div style="padding:6px 10px;border-radius:6px;background:#111;color:#fff">${it.qty}</div>
                            <button class="btn small" onclick="changeQty('${it.id}',1)">+</button>
                        </div>
                        <button class="btn ghost" onclick="removeFromCart('${it.id}')">Remove</button>
                    </div>
                </div>
            </div>
        `).join('');
        const total = items.reduce((s,i)=>s+i.price*i.qty,0);
        const totalEl = DOM.q('#cart-total');
        if(totalEl) totalEl.textContent = Formatter.money(total);
    });
}

/* ---------- Checkout ---------- */
async function placeOrder(e){
    e.preventDefault();
    const user = auth.currentUser;
    if(!user){ 
        alert('Please login first'); 
        window.location.href='login.html'; 
        return false; 
    }

    const name = (DOM.q('#chk-name')||{}).value?.trim();
    const address = (DOM.q('#chk-address')||{}).value?.trim();
    const phone = (DOM.q('#chk-phone')||{}).value?.trim();
    const payment = (DOM.q('#chk-payment')||{}).value || 'COD';
    if(!name || !address || !phone){ alert('Complete all fields'); return false; }

    const cart = getCart();
    if(!cart.length){ alert('Cart is empty'); return false; }

    try{
        const snaps = await Promise.all(cart.map(ci=>Firestore.products().doc(ci.id).get()));
        const invalid = snaps.filter(s=>!s.exists);
        if(invalid.length){ alert('Some items are no longer available. Refresh cart.'); return false; }

        const items = snaps.map((doc, idx)=>({
            productId: doc.id,
            title: doc.data().title,
            price: doc.data().price,
            qty: cart[idx].qty
        }));
        const total = items.reduce((sum, i)=>sum + i.price * i.qty, 0);

        const orderObj = {
            userId: user.uid,
            userName: name,
            phone,
            address,
            payment,
            items,
            total,
            status: 'Pending',
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        const orderRef = await Firestore.orders().add(orderObj);

        saveCart([]);
        renderCartCount();
        toggleCart(false);
        closeCheckout();

        openOrderSummary(`Your order ID is ${orderRef.id}. You can track its status in "My Orders".`);

    } catch(err){
        console.error(err);
        alert('Checkout failed: ' + (err.message || err));
    }

    return false;
}

function openCheckout(){ 
    const modal = DOM.q('#checkout-modal'); 
    if(modal) {
        modal.style.display='flex'; 
        modal.setAttribute('aria-hidden','false'); 
    }
}

function closeCheckout(){ 
    const modal = DOM.q('#checkout-modal'); 
    if(modal) {
        modal.style.display='none'; 
        modal.setAttribute('aria-hidden','true'); 
    }
}

/* ---------- Customer Orders ---------- */
function initCustomerOrders(){
    const container = DOM.q('#orders-table');
    if(!container) return;

    auth.onAuthStateChanged(user => {
        if(!user){
            alert('Please login to view your orders');
            window.location.href = 'login.html';
            return;
        }

        Firestore.orders()
            .where('userId', '==', user.uid)
            .orderBy('createdAt', 'desc')
            .onSnapshot(snapshot => {
                const orders = [];
                snapshot.forEach(doc => {
                    const data = doc.data();
                    orders.push({
                        id: doc.id,
                        items: data.items || [],
                        total: data.total || 0,
                        status: data.status || 'Pending',
                        createdAt: data.createdAt ? data.createdAt.toDate() : new Date()
                    });
                });

                if(!orders.length){
                    container.innerHTML = '<p>You have no orders yet.</p>';
                    return;
                }

                container.innerHTML = orders.map(o => `
                    <div class="order-card">
                        <div><strong>Order ID:</strong> ${o.id}</div>
                        <div><strong>Date:</strong> ${o.createdAt.toLocaleString()}</div>
                        <div><strong>Total:</strong> ${Formatter.money(o.total)}</div>
                        <div><strong>Status:</strong> <span class="order-status">${o.status}</span></div>
                        <div><strong>Items:</strong><br/>${o.items.map(i => `${i.title} ×${i.qty}`).join('<br/>')}</div>
                        <hr/>
                    </div>
                `).join('');
            }, err => {
                console.error('Orders listener error', err);
                container.innerHTML = '<p>Failed to load orders, please refresh the page.</p>';
            });
    });
}

function openOrderSummary(text){
    const modal = DOM.q('#order-summary-modal');
    if(modal){
        DOM.q('#summary-text').textContent = text;
        modal.style.display='flex';
        modal.setAttribute('aria-hidden','false');
    }
}

function closeOrderSummary(){
    const modal = DOM.q('#order-summary-modal');
    if(modal){
        modal.style.display='none';
        modal.setAttribute('aria-hidden','true');
    }
}

function goToOrders(){ window.location.href='orders.html'; }

/* ---------- Admin ---------- */
let adminProducts=[];
function initAdmin(){
    if(!DOM.q('#admin-product-list')) return;

    Firestore.products().orderBy('createdAt','desc').onSnapshot(snap=>{
        const arr=[]; 
        snap.forEach(d=>arr.push({id:d.id,...d.data()})); 
        adminProducts=arr;
        renderAdminProducts();
    });

    renderAdminProducts();
    initAdminOrders();
}

function renderAdminProducts(){
    const container = DOM.q('#admin-product-list'); 
    if(!container) return;
    
    const search = (DOM.q('#admin-search')||{}).value?.trim().toLowerCase();
    let list = adminProducts;
    if(search) list = list.filter(p => 
        p.title.toLowerCase().includes(search) || 
        (p.category || '').toLowerCase().includes(search)
    );

    container.innerHTML = list.map(p=>{
        const imgSrc = p.imgUrl || Utils.placeholderDataURL(p.title);
        return `
            <div class="admin-item" style="
                display:flex; 
                align-items:center; 
                gap:12px; 
                padding:12px; 
                border-bottom:1px solid #333;
                background:#111;
                color:#eee;
                border-radius:8px;
            ">
                <div style="flex:0 0 100px;">
                    <img src="${imgSrc}" alt="${Formatter.escapeHtml(p.title)}" 
                         style="width:100px;height:100px;object-fit:cover;border-radius:8px;border:1px solid #444;">
                </div>
                <div style="flex:1; display:flex; flex-direction:column; gap:4px;">
                    <strong>${Formatter.escapeHtml(p.title)}</strong>
                    <div>${Formatter.money(p.price)}</div>
                    <div style="opacity:0.7">${Formatter.escapeHtml(p.category)}</div>
                </div>
                <div style="flex:0 0 auto; display:flex; gap:8px;">
                    <button class="btn small" onclick="editProduct('${p.id}')">Edit</button>
                    <button class="btn ghost small" onclick="deleteProduct('${p.id}')">Delete</button>
                </div>
            </div>
        `;
    }).join('');
}

function showAddProduct(){ 
    DOM.q('#product-form-area').style.display='block'; 
    DOM.q('#product-form-title').textContent='Add Product'; 
    DOM.q('#product-form').reset(); 
    DOM.q('#p-id').value=''; 
}

function hideProductForm(){ 
    DOM.q('#product-form-area').style.display='none'; 
}

async function saveProduct(e){
    e.preventDefault();
    const id = DOM.q('#p-id').value;
    const title = DOM.q('#p-title').value.trim();
    const price = Number(DOM.q('#p-price').value);
    const stock = Number(DOM.q('#p-stock').value);
    const category = DOM.q('#p-category').value.trim();
    const desc = DOM.q('#p-desc').value.trim();
    const imgUrl = (DOM.q('#p-image-url')||{}).value.trim();
    
    if(!title || isNaN(price)) return alert('Invalid input');
    
    try{
        const data = {title, price, stock, category, desc};
        if(imgUrl) data.imgUrl = imgUrl;
        if(id) await Firestore.products().doc(id).update(data);
        else await Firestore.products().add({...data, createdAt: firebase.firestore.FieldValue.serverTimestamp()});
        hideProductForm();
    }catch(err){ 
        console.error(err); 
        alert('Failed to save product: '+(err.message||err)); 
    }
}

async function editProduct(id){
    const doc = await Firestore.products().doc(id).get();
    if(!doc.exists) return alert('Product not found');
    const p = doc.data();
    DOM.q('#p-id').value=doc.id;
    DOM.q('#p-title').value=p.title;
    DOM.q('#p-price').value=p.price;
    DOM.q('#p-stock').value=p.stock||0;
    DOM.q('#p-category').value=p.category;
    DOM.q('#p-desc').value=p.desc||'';
    DOM.q('#p-image-url').value=p.imgUrl||'';
    DOM.q('#product-form-area').style.display='block';
    DOM.q('#product-form-title').textContent='Edit Product';
}

async function deleteProduct(id){ 
    if(!confirm('Delete this product?')) return; 
    try{ 
        await Firestore.products().doc(id).delete(); 
    } catch(err){ 
        console.error(err); 
        alert('Delete failed'); 
    } 
}

/* ---------- Admin Orders Management ---------- */
function initAdminOrders(){
    const tbody = DOM.q('#admin-orders'); 
    if(!tbody) return;
    
    Firestore.orders().orderBy('createdAt','desc').onSnapshot(snapshot=>{
        const rows = [];
        snapshot.forEach(doc=>{
            const o = {id: doc.id, ...doc.data()};
            const items = o.items.map(i=>`${i.title} ×${i.qty}`).join('<br>');
            const statusColor = {
                'Pending':'orange',
                'Processing':'blue',
                'Shipped':'purple',
                'Delivered':'green'
            }[o.status] || 'gray';
            rows.push(`
                <tr>
                    <td>${o.id}</td>
                    <td>${Formatter.escapeHtml(o.userName)}</td>
                    <td>${items}</td>
                    <td>${Formatter.money(o.total)}</td>
                    <td style="color:${statusColor};font-weight:bold">${o.status}</td>
                    <td>
                        ${o.status!=='Delivered'?`<button class="btn small" onclick="advanceOrder('${o.id}')">Next Stage</button>`:''}
                    </td>
                </tr>
            `);
        });
        tbody.innerHTML = rows.join('');
    });
}

async function advanceOrder(id){
    const doc = await Firestore.orders().doc(id).get();
    if(!doc.exists) return alert('Order not found');
    const statusFlow = ['Pending','Processing','Shipped','Delivered'];
    const current = doc.data().status;
    const next = statusFlow[statusFlow.indexOf(current)+1];
    if(!next) return;
    await Firestore.orders().doc(id).update({status: next});
}

/* ---------- Footer ---------- */
function setFooterYear(){ 
    const f = DOM.q('footer'); 
    if(f) f.innerHTML=f.innerHTML.replace('{year}', new Date().getFullYear()); 
}

/* ---------- End of script.js ---------- */




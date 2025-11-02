// firebase-config.js — fixed for compat SDK

// Initialize Firebase using compat syntax (no import)
const firebaseConfig = {
  apiKey: "AIzaSyBDYLrPmmPvu0PfEa6qIDv4kgyHQM8mQ54",
  authDomain: "cobaintech-aff85.firebaseapp.com",
  projectId: "cobaintech-aff85",
  storageBucket: "cobaintech-aff85.appspot.com",
  messagingSenderId: "70064253311",
  appId: "1:70064253311:web:fd7b0680f82143f308124a",
  measurementId: "G-1BEEG4EVBR"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Initialize Firebase services
const auth = firebase.auth();
const db = firebase.firestore();
const storage = firebase.storage();

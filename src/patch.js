
// === Patch: ensure overlays don't block UI after loading; blur status; enable controls ===
(function(){
  try{
    const once = (el, ev, fn)=> el && el.addEventListener(ev, (...a)=>{ try{ fn(...a); }finally{ el.removeEventListener(ev, fn, {once:true}); } }, {once:true});
    const safe = fn=>{ try{ fn(); }catch(_){} };

    function hideOverlaysAndBlur(){
      safe(()=> dropmask && dropmask.classList.remove('show'));
      safe(()=> introBackdrop && introBackdrop.classList.remove('show'));
      safe(()=> status && status.classList.remove('show'));
      safe(()=> document.activeElement && document.activeElement.blur && document.activeElement.blur());
    }

    // On drop: hide masks immediately
    if (typeof viewer!=='undefined'){
      viewer.addEventListener('drop', ()=>{ hideOverlaysAndBlur(); }, {capture:true});
    }

    // After metadata/data/canplay: hide overlays and ensure buttons are active
    ['loadedmetadata','loadeddata','canplay'].forEach(ev=>{
      if (typeof video!=='undefined' && video){
        video.addEventListener(ev, ()=>{
          hideOverlaysAndBlur();
          try{
            if (playBtn) playBtn.disabled = false;
            if (stepBackBtn) stepBackBtn.disabled = false;
            if (stepFwdBtn) stepFwdBtn.disabled = false;
          }catch(_){}
        }, {once:false});
      }
    });

  }catch(_){}
})();


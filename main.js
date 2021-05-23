console.log("komootGPXport activated");

const interval = setInterval(function () {
    const downloadBtn = document.querySelector("[data-test-id=p_tour_save]");
    if (!downloadBtn) return;

    clearInterval(interval);
    downloadBtn.innerHTML = "Download GPX";
    downloadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();

        const coords = kmtBoot.getProps().page.linksEmbedded.tour.linksEmbedded.coordinates.attributes.items;

        if (!coords) {
            alert('There was an error reading the points of your route. If this keeps happening feel free to open an issue.');
            return;
        }

        const gpx = jsonToGpx(coords);
        downloadGpx(`route.gpx`, gpx);
    })
}, 1000);

const jsonToGpx = (coords) => {
    let gpx =
        `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<gpx version="1.1" creator="komootGPXport">
  <metadata></metadata>
  <rte>
  ${coords.map((coord) => {
            return `<rtept lat="${coord.lat}" lon="${coord.lng}"><ele>${coord.alt}</ele></rtept>`
        }).join('\n')
        }
  </rte>
</gpx>`;

    return gpx;
}

const downloadGpx = (filename, text) => {
    let elem = document.createElement('a');
    elem.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(text));
    elem.setAttribute('download', filename);

    elem.style.display = 'none';
    document.body.appendChild(elem);

    elem.click();

    document.body.removeChild(elem);
}